/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  AdminPermission,
  AuditLogAction,
  AuditService,
  BaseResponseDto,
  NOTIFICATIONS_SERVICE,
  PermissionRepository,
  RefreshToken,
  RefreshTokenRepository,
  User,
  UserRoleEntity,
  UserRepository,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, EntityManager } from 'typeorm';
import { AppleAuthDto } from './dto/apple-auth.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateAppAdminDto } from './dto/create-app-admin.dto';
import { EmailLoginDto } from './dto/email-login.dto';
import { EmailSignupDto } from './dto/email-signup.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { AppleAuthService } from './services/apple-auth.service';
import { GoogleAuthService } from './services/google-auth.service';
import { JwtAuthService } from './services/jwt.service';
import { PasswordService } from './services/password.service';

const DEFAULT_ROLE_CODE = 'actor';
const SYSTEM_ADMIN_ROLE_CODE = 'system_admin';
const APP_ADMIN_ROLE_CODE = 'app_admin';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly VERIFICATION_CODE_EXPIRY_MINUTES = 10;

  private getPrimaryRoleCode(user: User): string {
    return user.role?.code ?? DEFAULT_ROLE_CODE;
  }

  private getRoleCodes(user: User): string[] {
    const roleCode = this.getPrimaryRoleCode(user);
    return roleCode ? [roleCode] : [];
  }

  private async getRoleEntityByCode(
    manager: EntityManager,
    code: string,
  ): Promise<UserRoleEntity> {
    const role = await manager
      .getRepository(UserRoleEntity)
      .findOne({ where: { code } });
    if (!role) {
      throw new BadRequestException(`Role "${code}" does not exist`);
    }
    return role;
  }

  private resolvePermissionsForToken(user: User): string[] {
    const roleCode = this.getPrimaryRoleCode(user);
    if (roleCode === SYSTEM_ADMIN_ROLE_CODE) {
      return Object.values(AdminPermission);
    }
    const userPermissions = (user.permissions ?? [])
      .filter((permission): permission is NonNullable<typeof permission> =>
        Boolean(permission?.code),
      )
      .map((permission) => permission.code);
    return Array.from(new Set(userPermissions));
  }

  /**
   * Get resolved permissions for a user by ID. Returns all AdminPermission values for system_admin,
   * or the user's assigned permissions for app_admin. Returns [] for other roles or if user not found.
   */
  async getPermissionsForUserId(userId: string): Promise<string[]> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!user) return [];
    return this.resolvePermissionsForToken(user);
  }

  constructor(
    private readonly userRepository: UserRepository,
    private readonly permissionRepository: PermissionRepository,
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly auditService: AuditService,
    private readonly passwordService: PasswordService,
    private readonly jwtAuthService: JwtAuthService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly appleAuthService: AppleAuthService,
    private readonly dataSource: DataSource,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsService: ClientProxy,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate a 6-digit verification code (OTP)
   * Note: Verification codes are sent via EMAIL only, not via SMS or phone
   */
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Generate verification code expiry date
   */
  private getVerificationCodeExpiry(): Date {
    const expiry = new Date();
    expiry.setMinutes(
      expiry.getMinutes() + this.VERIFICATION_CODE_EXPIRY_MINUTES,
    );
    return expiry;
  }

  async signupWithEmail(signupDto: EmailSignupDto): Promise<AuthResponseDto> {
    // Check for existing user OUTSIDE transaction first
    const existingUser = await this.dataSource
      .getRepository(User)
      .findOne({ where: { email: signupDto.email } });

    if (existingUser && !existingUser.emailVerified) {
      // if user exists but hasn't verified email, we resend verification code
      // doing this outside the transaction so it doesn't get rolled back when we throw
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await this.sendVerificationEmail(existingUser, manager);
      });

      // throw error, the code update above is already committed
      throw new ConflictException(
        'An account with this email already exists but is not verified. A new verification code has been sent to your email. Please verify your email using the code at POST /auth/verify-code, then set your password at POST /auth/set-password.',
      );
    } else if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // if no existing user, proceed with signup in transaction
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const userRepo = manager.getRepository(User);

        if (signupDto.phoneNumber) {
          const existingPhoneUser = await userRepo.findOne({
            where: { phoneNumber: signupDto.phoneNumber },
          });
          if (existingPhoneUser) {
            throw new ConflictException(
              'User with this phone number already exists',
            );
          }
        }

        // generate verification code
        const verificationCode = this.generateVerificationCode();
        const verificationCodeExpiry = this.getVerificationCodeExpiry();
        const selectedRoleCode = signupDto.role || DEFAULT_ROLE_CODE;
        const selectedRole = await this.getRoleEntityByCode(
          manager,
          selectedRoleCode,
        );

        const user = userRepo.create({
          email: signupDto.email,
          password: null,
          fullName: signupDto.fullName,
          phoneNumber: signupDto.phoneNumber,
          roleId: selectedRole.id,
          role: selectedRole,
          timezone: signupDto.timezone || 'UTC',
          emailVerified: false,
          emailVerificationCode: verificationCode,
          emailVerificationCodeExpiry: verificationCodeExpiry,
        });
        await userRepo.save(user);

        await this.sendVerificationEmail(user, manager);

        const authResponse = await this.generateAuthResponse(
          user,
          manager,
          'Account created successfully. Please verify your email.',
        );

        return { authResponse, user };
      },
    );

    // Send welcome email (fire-and-forget, after transaction commits)
    this.notificationsService.emit('user.registered', {
      userId: result.user.id,
      email: result.user.email,
      fullName: result.user.fullName,
    });

    return result.authResponse;
  }

  /**
   * Send verification code via EMAIL only
   * Note: OTP/verification codes are sent via email channel only, not via SMS or phone
   */
  private async sendVerificationEmail(
    user: User,
    manager: EntityManager,
  ): Promise<void> {
    // generate and send a new verification code via EMAIL
    if (!user.emailVerified && user.email) {
      const userRepo = manager.getRepository(User);
      const verificationCode = this.generateVerificationCode();
      const verificationCodeExpiry = this.getVerificationCodeExpiry();

      // update user with new code and save to database
      user.emailVerificationCode = verificationCode;
      user.emailVerificationCodeExpiry = verificationCodeExpiry;
      await userRepo.save(user);

      // send verification email (fire-and-forget)
      this.notificationsService.emit('notification.created', {
        recipientUserId: user.id,
        title: 'Welcome to ACR',
        body: 'Thank you for signing up!',
        channels: ['email'],
        email: user.email,
        template: 'verify-code',
        data: {
          name: user.fullName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          roles: this.getRoleCodes(user),
          avatar: user.avatar,
          code: verificationCode,
          expiryTime: `${this.VERIFICATION_CODE_EXPIRY_MINUTES} minutes`,
        },
      });

      this.logger.log(`Verification code email queued for user ${user.id}`);
    }
  }

  /**
   * Send verification code via EMAIL for OAuth users (synchronous version for use outside transactions)
   * Note: OTP/verification codes are sent via email channel only, not via SMS or phone
   */
  private sendVerificationCodeForOAuthUserSync(
    user: User,
    verificationCode: string,
  ): void {
    if (!user.email) {
      // Verification codes can only be sent via email, not phone
      this.logger.warn(
        `Cannot send verification code for user ${user.id}: no email address`,
      );
      return;
    }

    this.notificationsService.emit('notification.created', {
      recipientUserId: user.id,
      title: 'Complete Your Email Verification',
      body: 'Please verify your email to continue',
      channels: ['email'],
      email: user.email,
      template: 'verify-code',
      data: {
        name: user.fullName || user.email,
        email: user.email,
        phoneNumber: user.phoneNumber,
        roles: this.getRoleCodes(user),
        avatar: user.avatar,
        code: verificationCode,
        expiryTime: `${this.VERIFICATION_CODE_EXPIRY_MINUTES} minutes`,
      },
    });

    this.logger.log(`Verification code email queued for OAuth user ${user.id}`);
  }

  /**
   * Send verification code via EMAIL for OAuth users who need to verify email
   * Note: OTP/verification codes are sent via email channel only, not via SMS or phone
   */
  private async sendVerificationCodeForOAuthUser(
    user: User,
    manager: EntityManager,
  ): Promise<void> {
    if (!user.email) {
      return;
    }

    const userRepo = manager.getRepository(User);
    const verificationCode = this.generateVerificationCode();
    const verificationCodeExpiry = this.getVerificationCodeExpiry();

    user.emailVerificationCode = verificationCode;
    user.emailVerificationCodeExpiry = verificationCodeExpiry;
    await userRepo.save(user);

    // Send verification email using the sync version
    this.sendVerificationCodeForOAuthUserSync(user, verificationCode);
  }

  /**
   * Send password reset email with verification code
   */
  private async sendPasswordResetEmail(
    user: User,
    resetCode: string,
  ): Promise<void> {
    if (!user.email) {
      return;
    }

    this.notificationsService.emit('notification.created', {
      recipientUserId: user.id,
      title: 'Reset Your Password',
      body: 'Use the code below to reset your password',
      channels: ['email'],
      email: user.email,
      template: 'forgot-password',
      data: {
        userName: user.fullName || user.email,
        code: resetCode,
        expiryTime: `${this.VERIFICATION_CODE_EXPIRY_MINUTES} minutes`,
      },
    });

    this.logger.log(`Password reset email queued for user ${user.id}`);
  }

  /**
   * Login with email/password or phone/password
   * Note: Phone number login does NOT use OTP/verification codes.
   * Verification codes (OTP) are EMAIL-ONLY and are only used for email verification during signup.
   */
  async loginWithEmail(loginDto: EmailLoginDto): Promise<AuthResponseDto> {
    let user: User | null = null;

    if (loginDto.email) {
      user = await this.userRepository.findOne({
        where: { email: loginDto.email },
        withDeleted: true, // Include soft-deleted users to check status
      });
    }

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is disabled or soft-deleted
    if (user.disabled || user.deletedAt) {
      throw new UnauthorizedException('Account has been disabled or deleted');
    }

    if (!user.password) {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        await this.sendVerificationCodeForOAuthUser(user, manager);
      });
      throw new UnauthorizedException(
        'Account setup incomplete. Please complete the following steps: 1) Verify your email using the verification code sent to your email at POST /auth/verify-code, 2) Set your password at POST /auth/set-password, then you can login.',
      );
    }

    const isPasswordValid = await this.passwordService.comparePassword(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.dataSource.transaction(async (manager) => {
      await this.updateLastLogin(user, manager);
      // refreshToken and persistence handled by generateAuthResponse
      return this.generateAuthResponse(user, manager);
    });
  }

  async authenticateWithGoogle(
    googleAuthDto: GoogleAuthDto,
  ): Promise<AuthResponseDto> {
    const googleUserInfo = await this.googleAuthService.verifyAccessToken(
      googleAuthDto.accessToken,
    );

    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      let user = await userRepo.findOne({
        where: { googleId: googleUserInfo.id },
        withDeleted: true, // Include soft-deleted users to check status
      });

      if (!user) {
        user = await userRepo.findOne({
          where: { email: googleUserInfo.email },
          withDeleted: true, // Include soft-deleted users to check status
        });
        if (user) {
          // Check if user is disabled or soft-deleted
          if (user.disabled || user.deletedAt) {
            throw new UnauthorizedException(
              'Account has been disabled or deleted',
            );
          }
          user.googleId = googleUserInfo.id;
          if (!user?.avatar) {
            user.avatar = googleUserInfo.picture;
          }
          // Don't set emailVerified automatically - it will be set when user sets password
          // Only set to false if not already verified and user has no password
          if (!user.password && !user.emailVerified) {
            user.emailVerified = false;
          }
          await userRepo.save(user);
        }
      } else {
        // Check if user is disabled or soft-deleted
        if (user.disabled || user.deletedAt) {
          throw new UnauthorizedException(
            'Account has been disabled or deleted',
          );
        }
      }

      if (!user) {
        const actorRole = await this.getRoleEntityByCode(
          manager,
          DEFAULT_ROLE_CODE,
        );
        user = userRepo.create({
          email: googleUserInfo.email,
          googleId: googleUserInfo.id,
          fullName: googleUserInfo?.given_name
            ? `${googleUserInfo?.given_name} ${googleUserInfo?.family_name}`
            : googleUserInfo?.name,
          avatar: googleUserInfo.picture || '',
          roleId: actorRole.id,
          role: actorRole,
          emailVerified: false, // Email will be verified only after set-password is called
        });
        await userRepo.save(user);
      } else {
        await this.updateLastLogin(user, manager);
      }

      // Check if user needs to set password and verify email
      // if (!user.password && !user.emailVerified) {
      //   await this.sendVerificationCodeForOAuthUser(user, manager);
      //   throw new UnauthorizedException(
      //     'Please complete your email verification. A verification code has been sent to your email. Please check your email and verify your account using the verify-code endpoint, then set a password using the set-password endpoint.',
      //   );
      // }

      return this.generateAuthResponse(user, manager);
    });
  }

  async authenticateWithApple(
    appleAuthDto: AppleAuthDto,
  ): Promise<AuthResponseDto> {
    const appleUserInfo = await this.appleAuthService.verifyIdentityToken(
      appleAuthDto.identityToken,
      appleAuthDto.authorizationCode,
    );

    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      let user = await userRepo.findOne({
        where: { appleId: appleUserInfo.id },
        withDeleted: true, // Include soft-deleted users to check status
      });

      if (!user && appleUserInfo.email) {
        user = await userRepo.findOne({
          where: { email: appleUserInfo.email },
          withDeleted: true, // Include soft-deleted users to check status
        });
        if (user) {
          // Check if user is disabled or soft-deleted
          if (user.disabled || user.deletedAt) {
            throw new UnauthorizedException(
              'Account has been disabled or deleted',
            );
          }
          user.appleId = appleUserInfo.id;
          if (appleUserInfo.name) {
            user.fullName = `${appleUserInfo.name.firstName} ${appleUserInfo.name.lastName}`;
          }
          // Don't set emailVerified automatically - it will be set when user sets password
          // Only set to false if not already verified and user has no password
          if (!user.password && !user.emailVerified) {
            user.emailVerified = false;
          }
          await userRepo.save(user);
        }
      } else if (user) {
        // Check if user is disabled or soft-deleted
        if (user.disabled || user.deletedAt) {
          throw new UnauthorizedException(
            'Account has been disabled or deleted',
          );
        }
      }

      if (!user) {
        const actorRole = await this.getRoleEntityByCode(
          manager,
          DEFAULT_ROLE_CODE,
        );
        user = userRepo.create({
          email: appleUserInfo.email,
          appleId: appleUserInfo.id,
          fullName: `${appleUserInfo.name?.firstName} ${appleUserInfo.name?.lastName}`,
          roleId: actorRole.id,
          role: actorRole,
          emailVerified: false, // Email will be verified only after set-password is called
        });
        await userRepo.save(user);
      } else {
        await this.updateLastLogin(user, manager);
      }

      // Check if user needs to set password and verify email
      if (!user.password && !user.emailVerified) {
        await this.sendVerificationCodeForOAuthUser(user, manager);
        throw new UnauthorizedException(
          'Please complete your email verification. A verification code has been sent to your email. Please check your email and verify your account using the verify-code endpoint, then set a password using the set-password endpoint.',
        );
      }

      return this.generateAuthResponse(user, manager);
    });
  }

  /**
   * Send password reset code to user's email
   * Generates a 6-digit code and sends it via email for password reset
   */
  async forgotPassword(email: string): Promise<BaseResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);
      const user = await this.findUserByEmail(userRepo, email);

      // Check if user has a password (not OAuth-only user)
      if (!user.password) {
        throw new BadRequestException(
          'This account uses social login. Please use Google or Apple to sign in.',
        );
      }

      const resetCode = this.generateVerificationCode();
      const expiryDate = this.getVerificationCodeExpiry();

      // Store reset code in the same fields (we'll clear email verification if needed)
      user.emailVerificationCode = resetCode;
      user.emailVerificationCodeExpiry = expiryDate;
      await userRepo.save(user);

      await this.sendPasswordResetEmail(user, resetCode);

      this.logger.log(
        `Password reset code sent for user ${user.id} (${email})`,
      );

      return {
        success: true,
        message: 'Password reset code has been sent to your email',
      };
    });
  }

  /**
   * Resend verification code to user's email
   * Generates a new 6-digit code and sends it via email
   */
  async resendVerificationCode(email: string): Promise<BaseResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);
      const user = await this.findUserByEmail(userRepo, email);

      const newCode = this.generateVerificationCode();
      const expiryDate = this.getVerificationCodeExpiry();

      user.emailVerificationCode = newCode;
      user.emailVerificationCodeExpiry = expiryDate;
      await userRepo.save(user);

      await this.sendVerificationEmail(user, manager);

      this.logger.log(
        `Verification code resent for user ${user.id} (${email})`,
      );

      return {
        success: true,
        message: 'Verification code has been sent to your email',
      };
    });
  }

  /**
   * Verify email with verification code
   * Validates the code, checks expiry, marks email as verified, and returns JWT tokens
   */
  async verifyCode(email: string, code: string): Promise<AuthResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);
      const user = await this.findUserByEmail(userRepo, email);

      this.logger.log(`Verifying email for user ${user.id} (${email})`);

      this.validateUserCanVerifyEmail(user);
      await this.validateVerificationCode(user, code, userRepo);

      // For users without password (email-only signups), return JWT tokens
      // so they can call /auth/set-password to complete account setup
      if (!user.password) {
        // Clear verification code to mark this step as complete
        user.emailVerificationCode = null;
        user.emailVerificationCodeExpiry = null;
        await userRepo.save(user);

        this.logger.log(
          `Email verified for user ${user.id} (${email}). User can now set password using JWT tokens.`,
        );

        // Return JWT tokens so user can call /auth/set-password
        return this.generateAuthResponse(user, manager);
      }

      // For users with password (email signup), set email as verified
      user.emailVerified = true;
      user.emailVerificationCode = null;
      user.emailVerificationCodeExpiry = null;
      await userRepo.save(user);

      this.logger.log(
        `Email verified successfully for user ${user.id} (${email})`,
      );

      return this.generateAuthResponse(user, manager);
    });
  }

  async refreshToken(refreshToken: string): Promise<AuthResponseDto> {
    refreshToken = typeof refreshToken === 'string' ? refreshToken.trim() : '';
    if (!refreshToken) {
      this.logger.warn(
        'Refresh token validation failed: token is missing or invalid type',
      );
      throw new UnauthorizedException('Refresh token is required');
    }

    try {
      // Verify JWT signature first — fast fail before hitting the DB
      const payload = this.jwtAuthService.verifyRefreshToken(refreshToken);
      const resolvedUserId =
        this.jwtAuthService.resolveUserIdFromPayload(payload);
      const tokenHash = this.hashToken(refreshToken);

      return await this.dataSource.transaction(async (manager) => {
        const rtRepo = manager.getRepository(RefreshToken);

        // Lock the token row to prevent concurrent rotations
        const storedToken = await rtRepo
          .createQueryBuilder('rt')
          .setLock('pessimistic_write')
          .where('rt.tokenHash = :tokenHash', { tokenHash })
          .getOne();

        if (!storedToken) {
          this.logger.warn(
            `Refresh token not found in DB for user ${resolvedUserId ?? 'unknown'}`,
          );
          throw new UnauthorizedException('Invalid refresh token');
        }

        if (storedToken.revokedAt) {
          this.logger.warn(
            `Replay attack detected for user ${resolvedUserId ?? 'unknown'} — revoking family ${storedToken.family}`,
          );
          await rtRepo
            .createQueryBuilder()
            .update(RefreshToken)
            .set({ revokedAt: new Date() })
            .where('family = :family AND revokedAt IS NULL', {
              family: storedToken.family,
            })
            .execute();
          throw new UnauthorizedException(
            'Security violation: refresh token already used. All sessions have been terminated. Please log in again.',
          );
        }

        if (storedToken.expiresAt < new Date()) {
          throw new UnauthorizedException(
            'Refresh token has expired. Please log in again.',
          );
        }

        const userRepo = manager.getRepository(User);
        if (!resolvedUserId) {
          throw new UnauthorizedException('Invalid refresh token');
        }
        const user = await userRepo.findOne({
          where: { id: resolvedUserId },
          withDeleted: true,
          relations: { role: true },
        });

        if (!user) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        if (user.disabled || user.deletedAt) {
          this.logger.warn(
            `Refresh token attempt for disabled/deleted user ${user.id}`,
          );
          throw new UnauthorizedException(
            'Account has been disabled or deleted',
          );
        }

        storedToken.revokedAt = new Date();
        await rtRepo.save(storedToken);

        return this.generateAuthResponse(
          user,
          manager,
          'Authentication successful',
          storedToken.family,
        );
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      const errorName =
        (error as any)?.name || (error as any)?.constructor?.name;
      const errorMessage = (error as any)?.message || 'Unknown error';

      if (
        errorName === 'TokenExpiredError' ||
        errorMessage.includes('expired')
      ) {
        this.logger.warn(`Refresh token expired: ${errorMessage}`);
        throw new UnauthorizedException(
          'Refresh token has expired. Please log in again.',
        );
      }

      if (
        errorName === 'JsonWebTokenError' ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('malformed')
      ) {
        this.logger.warn(`JWT verification error: ${errorMessage}`);
        throw new UnauthorizedException(
          `Invalid refresh token: ${errorMessage.includes('secret') ? 'Token signature verification failed' : 'Token format is invalid'}`,
        );
      }

      if (
        errorName === 'NotBeforeError' ||
        errorMessage.includes('not active')
      ) {
        this.logger.warn(`Refresh token not yet active: ${errorMessage}`);
        throw new UnauthorizedException('Refresh token is not yet valid');
      }

      this.logger.error(
        `Unexpected error during refresh token validation: ${errorMessage}`,
        (error as any)?.stack || error,
      );
      throw new UnauthorizedException(`Invalid refresh token: ${errorMessage}`);
    }
  }

  async validateAccessToken(token: string) {
    try {
      const payload = this.jwtAuthService.verifyToken(token);
      const userId = this.jwtAuthService.resolveUserIdFromPayload(payload);
      if (!userId) {
        throw new UnauthorizedException('Invalid authentication token');
      }
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['permissions'],
        withDeleted: true, // Include soft-deleted users to check status
      });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Check if user is disabled or soft-deleted
      if (user.disabled || user.deletedAt) {
        throw new UnauthorizedException('Account has been disabled or deleted');
      }

      // Check if user without password needs to verify email and set password
      if (!user.password && !user.emailVerified) {
        // Generate and send verification code
        const verificationCode = this.generateVerificationCode();
        const verificationCodeExpiry = this.getVerificationCodeExpiry();

        user.emailVerificationCode = verificationCode;
        user.emailVerificationCodeExpiry = verificationCodeExpiry;
        await this.userRepository.save(user);

        // Send verification email asynchronously
        this.sendVerificationCodeForOAuthUserSync(user, verificationCode);

        throw new UnauthorizedException(
          'Please complete your email verification. A verification code has been sent to your email. Please check your email and verify your account using the verify-code endpoint, then set a password using the set-password endpoint.',
        );
      }

      const permissions = this.resolvePermissionsForToken(user);
      return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        roles: user.roles,
        permissions: this.resolvePermissionsForToken(user),
        avatar: user.avatar,
        emailVerified: user.emailVerified,
        timezone: user.timezone,
        deactivationReason: user.deactivationReason ?? null,
        deactivatedAt: user.deactivatedAt ?? null,
        reactivationReason: user.reactivationReason ?? null,
        reactivatedAt: user.reactivatedAt ?? null,
      };
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        throw e;
      }
      throw new UnauthorizedException('Invalid authentication token');
    }
  }

  /**
   * Logout user by clearing their refresh token
   * This invalidates the refresh token so it cannot be used to obtain new access tokens
   */
  async logout(
    userId: string,
    refreshToken?: string,
  ): Promise<BaseResponseDto> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken.trim());
      await this.refreshTokenRepository.revokeByHash(tokenHash);
      this.logger.log(`User ${userId} logged out — session token revoked.`);
    } else {
      await this.refreshTokenRepository.revokeAllForUser(userId);
      this.logger.log(`User ${userId} logged out — all sessions revoked.`);
    }

    return {
      success: true,
      message: 'Logged out successfully. Refresh token has been invalidated.',
    };
  }

  async logoutAll(userId: string): Promise<BaseResponseDto> {
    await this.refreshTokenRepository.revokeAllForUser(userId);
    this.logger.log(`User ${userId} — all sessions terminated.`);
    return {
      success: true,
      message: 'All sessions have been terminated.',
    };
  }

  /**
   * Create a new app admin user (SYSTEM_ADMIN only). Generates a temporary password
   * and sends it to the user's email via the notification service.
   */
  async createAppAdminUser(
    dto: CreateAppAdminDto,
    requestedByUserId: string,
    requestContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ message: string; email: string }> {
    const existing = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException(
        'A user with this email already exists. Use a different email.',
      );
    }

    const temporaryPassword = randomBytes(12).toString('hex');
    const hashedPassword =
      await this.passwordService.hashPassword(temporaryPassword);
    const appAdminRole = await this.dataSource
      .getRepository(UserRoleEntity)
      .findOne({ where: { code: APP_ADMIN_ROLE_CODE } });

    if (!appAdminRole) {
      throw new BadRequestException(
        'Required role "app_admin" does not exist. Seed roles first.',
      );
    }

    const user = this.userRepository.create({
      email: dto.email,
      fullName: dto.fullName ?? null,
      password: hashedPassword,
      roleId: appAdminRole.id,
      role: appAdminRole,
      emailVerified: true,
      timezone: 'UTC',
    });
    await this.userRepository.save(user);

    const requestedCodes = Array.from(new Set(dto.permissions ?? []));
    if (requestedCodes.length > 0) {
      const permissionEntities =
        await this.permissionRepository.findByCodes(requestedCodes);
      if (permissionEntities.length !== requestedCodes.length) {
        throw new BadRequestException(
          'One or more permissions are invalid. Use valid AdminPermission values.',
        );
      }
      user.permissions = permissionEntities;
      await this.userRepository.save(user);
    }

    this.notificationsService.emit('notification.created', {
      recipientUserId: user.id,
      title: 'Your ACR App Admin Account',
      body: 'Your app admin account has been created. Use the temporary password below to sign in.',
      channels: ['email'],
      email: user.email,
      template: 'app-admin-credentials',
      data: {
        email: user.email,
        fullName: user.fullName || user.email,
        temporaryPassword,
      },
    });

    this.logger.log(
      `App admin user created: ${user.id} (${user.email}) by system admin ${requestedByUserId}`,
    );

    await this.auditService.log({
      userId: requestedByUserId,
      action: AuditLogAction.ADMIN_CREATE_APP_ADMIN,
      resourceType: 'user',
      resourceId: user.id,
      metadata: {
        createdUserId: user.id,
        createdUserEmail: user.email,
        createdUserRole: APP_ADMIN_ROLE_CODE,
        grantedPermissions: requestedCodes,
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
    });

    return {
      message:
        'App admin account created. A temporary password has been sent to the provided email address.',
      email: user.email,
    };
  }

  /**
   * Update an app admin's permissions. SYSTEM_ADMIN only. Target must be an APP_ADMIN user.
   */
  async setAdminPermissions(
    targetUserId: string,
    permissionCodes: string[],
    requestedByUserId: string,
    requestContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ message: string; userId: string; permissions: string[] }> {
    const user = await this.userRepository.findOne({
      where: { id: targetUserId },
      relations: ['permissions'],
    });
    if (!user) {
      throw new NotFoundException('Target user not found');
    }
    if (this.getPrimaryRoleCode(user) !== APP_ADMIN_ROLE_CODE) {
      throw new BadRequestException(
        'Permissions can only be set for users with app_admin role',
      );
    }

    const uniqueCodes = Array.from(new Set(permissionCodes ?? []));
    const permissionEntities =
      await this.permissionRepository.findByCodes(uniqueCodes);
    if (permissionEntities.length !== uniqueCodes.length) {
      throw new BadRequestException(
        'One or more permissions are invalid. Use valid AdminPermission values.',
      );
    }

    user.permissions = permissionEntities;
    await this.userRepository.save(user);
    this.logger.log(
      `Admin permissions updated for user ${targetUserId} by system admin ${requestedByUserId}`,
    );

    await this.auditService.log({
      userId: requestedByUserId,
      action: AuditLogAction.ADMIN_SET_PERMISSIONS,
      resourceType: 'user',
      resourceId: user.id,
      metadata: {
        targetUserId: user.id,
        targetUserEmail: user.email,
        role: this.getPrimaryRoleCode(user),
        permissions: uniqueCodes,
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
    });

    return {
      message: 'Permissions updated successfully',
      userId: user.id,
      permissions: uniqueCodes,
    };
  }

  async deactivateUser(
    targetUserId: string,
    requestedBy: { id?: string; roles?: string[]; permissions?: string[] },
    reason?: string,
    requestContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    message: string;
    userId: string;
    disabled: boolean;
    reason: string | null;
    actionTime: string | null;
  }> {
    const requesterRoles = requestedBy?.roles ?? [];
    const requesterPermissions = requestedBy?.permissions ?? [];
    const isSystemAdmin = requesterRoles.includes(SYSTEM_ADMIN_ROLE_CODE);
    const isAppAdmin = requesterRoles.includes(APP_ADMIN_ROLE_CODE);
    const hasDeactivatePermission = requesterPermissions.includes(
      AdminPermission.USER_DEACTIVATE,
    );

    if (!isSystemAdmin && !(isAppAdmin && hasDeactivatePermission)) {
      throw new ForbiddenException(
        'Only system admins or app admins with user_deactivate permission can perform this action',
      );
    }

    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    if (targetUser.disabled) {
      return {
        message: 'User is already deactivated',
        userId: targetUser.id,
        disabled: true,
        reason: targetUser.deactivationReason ?? null,
        actionTime: targetUser.deactivatedAt?.toISOString() ?? null,
      };
    }

    const actionTime = new Date();
    const normalizedReason = reason?.trim() ? reason.trim() : null;
    targetUser.disabled = true;
    targetUser.deactivationReason = normalizedReason;
    targetUser.deactivatedAt = actionTime;
    targetUser.reactivationReason = null;
    targetUser.reactivatedAt = null;
    await this.userRepository.save(targetUser);
    await this.refreshTokenRepository.revokeAllForUser(targetUser.id);

    if (requestedBy?.id) {
      await this.auditService.log({
        userId: requestedBy.id,
        action: 'admin.user.deactivated',
        resourceType: 'user',
        resourceId: targetUser.id,
        metadata: {
          targetUserId: targetUser.id,
          targetEmail: targetUser.email,
          reason: targetUser.deactivationReason,
          actionTime: actionTime.toISOString(),
          performedByRole: requesterRoles,
        },
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
      });
    }

    if (targetUser.email) {
      this.notificationsService.emit('notification.created', {
        recipientUserId: targetUser.id,
        title: 'Account Deactivated',
        body: 'Your account has been deactivated.',
        channels: ['email'],
        email: targetUser.email,
        template: 'user-deactivated',
        data: {
          name: targetUser.fullName || targetUser.email,
          email: targetUser.email,
          reason: normalizedReason,
          deactivatedAt: actionTime.toISOString(),
        },
      });
      this.logger.log(
        `Deactivation notification email queued for user ${targetUser.id}`,
      );
    }

    return {
      message: 'User deactivated successfully',
      userId: targetUser.id,
      disabled: true,
      reason: targetUser.deactivationReason ?? null,
      actionTime: actionTime.toISOString(),
    };
  }

  async reactivateUser(
    targetUserId: string,
    requestedBy: { id?: string; roles?: string[]; permissions?: string[] },
    reason?: string,
    requestContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    message: string;
    userId: string;
    disabled: boolean;
    reason: string | null;
    actionTime: string | null;
  }> {
    const requesterRoles = requestedBy?.roles ?? [];
    const requesterPermissions = requestedBy?.permissions ?? [];
    const isSystemAdmin = requesterRoles.includes(SYSTEM_ADMIN_ROLE_CODE);
    const isAppAdmin = requesterRoles.includes(APP_ADMIN_ROLE_CODE);
    const hasDeactivatePermission = requesterPermissions.includes(
      AdminPermission.USER_DEACTIVATE,
    );

    if (!isSystemAdmin && !(isAppAdmin && hasDeactivatePermission)) {
      throw new ForbiddenException(
        'Only system admins or app admins with user_deactivate permission can perform this action',
      );
    }

    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    if (!targetUser.disabled) {
      return {
        message: 'User is already active',
        userId: targetUser.id,
        disabled: false,
        reason: targetUser.reactivationReason ?? null,
        actionTime: targetUser.reactivatedAt?.toISOString() ?? null,
      };
    }

    const actionTime = new Date();
    const normalizedReason = reason?.trim() ? reason.trim() : null;
    targetUser.disabled = false;
    targetUser.reactivationReason = normalizedReason;
    targetUser.reactivatedAt = actionTime;
    await this.userRepository.save(targetUser);
    await this.refreshTokenRepository.revokeAllForUser(targetUser.id);

    if (requestedBy?.id) {
      await this.auditService.log({
        userId: requestedBy.id,
        action: 'admin.user.reactivated',
        resourceType: 'user',
        resourceId: targetUser.id,
        metadata: {
          targetUserId: targetUser.id,
          targetEmail: targetUser.email,
          reason: targetUser.reactivationReason,
          actionTime: actionTime.toISOString(),
          performedByRole: requesterRoles,
        },
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
      });
    }

    return {
      message: 'User reactivated successfully',
      userId: targetUser.id,
      disabled: false,
      reason: targetUser.reactivationReason ?? null,
      actionTime: actionTime.toISOString(),
    };
  }

  async banUser(
    targetUserId: string,
    requestedBy: { id?: string; roles?: string[]; permissions?: string[] },
    reason?: string,
    requestContext?: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    message: string;
    userId: string;
    banned: boolean;
    reason: string | null;
    bannedAt: string | null;
  }> {
    const requesterRoles = requestedBy?.roles ?? [];
    const requesterPermissions = requestedBy?.permissions ?? [];
    const isSystemAdmin = requesterRoles.includes(SYSTEM_ADMIN_ROLE_CODE);
    const isAppAdmin = requesterRoles.includes(APP_ADMIN_ROLE_CODE);
    const hasBanPermission = requesterPermissions.includes(
      AdminPermission.USER_BAN,
    );

    if (!isSystemAdmin && !(isAppAdmin && hasBanPermission)) {
      throw new ForbiddenException(
        'Only system admins or app admins with user_ban permission can perform this action',
      );
    }

    const targetUser = await this.userRepository.findOne({
      where: { id: targetUserId },
      withDeleted: true,
    });
    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    if (targetUser.deletedAt) {
      return {
        message: 'User is already banned',
        userId: targetUser.id,
        banned: true,
        reason: targetUser.banReason ?? null,
        bannedAt: targetUser.bannedAt?.toISOString() ?? null,
      };
    }

    const actionTime = new Date();
    const normalizedReason = reason?.trim() ? reason.trim() : null;
    targetUser.bannedAt = actionTime;
    targetUser.banReason = normalizedReason;
    targetUser.deletedAt = actionTime;
    await this.userRepository.save(targetUser);
    await this.refreshTokenRepository.revokeAllForUser(targetUser.id);

    if (requestedBy?.id) {
      await this.auditService.log({
        userId: requestedBy.id,
        action: 'admin.user.banned',
        resourceType: 'user',
        resourceId: targetUser.id,
        metadata: {
          targetUserId: targetUser.id,
          targetEmail: targetUser.email,
          reason: targetUser.banReason,
          bannedAt: actionTime.toISOString(),
          performedByRole: requesterRoles,
        },
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
      });
    }

    if (targetUser.email) {
      this.notificationsService.emit('notification.created', {
        recipientUserId: targetUser.id,
        title: 'Account Banned',
        body: 'Your account has been banned.',
        channels: ['email'],
        email: targetUser.email,
        template: 'user-banned',
        data: {
          name: targetUser.fullName || targetUser.email,
          email: targetUser.email,
          reason: normalizedReason,
          bannedAt: actionTime.toISOString(),
        },
      });
      this.logger.log(
        `Ban notification email queued for user ${targetUser.id}`,
      );
    }

    return {
      message: 'User banned successfully',
      userId: targetUser.id,
      banned: true,
      reason: targetUser.banReason ?? null,
      bannedAt: actionTime.toISOString(),
    };
  }

  async generateAuthResponse(
    user: User,
    manager?: EntityManager,
    message = 'Authentication successful',
    family?: string,
  ): Promise<AuthResponseDto> {
    const accessToken = this.jwtAuthService.generateAccessToken(user);
    const rawRefreshToken = this.jwtAuthService.generateRefreshToken(user);

    // Derive expiry from the token's own exp claim so it stays in sync with jwt.service config
    const decoded = this.jwtAuthService.decodeToken(rawRefreshToken);
    let expiresAt: Date;
    if (
      decoded &&
      typeof decoded === 'object' &&
      typeof decoded.exp === 'number' &&
      Number.isFinite(decoded.exp)
    ) {
      expiresAt = new Date(decoded.exp * 1000);
    } else {
      this.logger.warn(
        'Refresh token JWT missing valid exp; using 7-day fallback for persistence',
      );
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
    const tokenHash = this.hashToken(rawRefreshToken);

    const rtEntity = {
      userId: user.id,
      tokenHash,
      family: family ?? randomUUID(),
      expiresAt,
    };

    if (manager) {
      await manager
        .getRepository(RefreshToken)
        .save(manager.getRepository(RefreshToken).create(rtEntity));
    } else {
      await this.refreshTokenRepository.createEntity(rtEntity);
    }

    return {
      success: true,
      message,
      data: {
        accessToken,
        refreshToken: rawRefreshToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user?.fullName,
          phoneNumber: user?.phoneNumber,
          roles: user?.roles,
          permissions: this.resolvePermissionsForToken(user),
          avatar: user?.avatar,
          emailVerified: user?.emailVerified,
          timezone: user?.timezone,
          deactivationReason: user?.deactivationReason ?? null,
          deactivatedAt: user?.deactivatedAt ?? null,
          reactivationReason: user?.reactivationReason ?? null,
          reactivatedAt: user?.reactivatedAt ?? null,
        },
      },
    };
  }

  private async updateLastLogin(
    user: User,
    manager?: EntityManager,
  ): Promise<void> {
    user.lastLoginAt = new Date();
    if (manager) {
      await manager.getRepository(User).save(user);
    } else {
      await this.userRepository.save(user);
    }
  }

  /**
   * Find user by email or throw exception
   */
  private async findUserByEmail(userRepo: any, email: string): Promise<User> {
    const user = await userRepo.findOne({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('User not found with this email');
    }

    return user;
  }

  /**
   * Validate that user can receive a verification code
   */
  // private validateUserCanReceiveVerificationCode(user: User): void {
  // 	if (user.emailVerified) {
  // 		throw new BadRequestException("Email is already verified");
  // 	}
  // }

  /**
   * Validate that user can verify their email
   */
  private validateUserCanVerifyEmail(user: User): void {
    if (!user.emailVerificationCode) {
      throw new BadRequestException(
        'No verification code found. Please request a new verification code.',
      );
    }
  }

  /**
   * Validate verification code matches and hasn't expired
   */
  private async validateVerificationCode(
    user: User,
    code: string,
    userRepo?: any,
  ): Promise<void> {
    // Check if code matches
    if (user.emailVerificationCode !== code) {
      throw new UnauthorizedException('Invalid verification code');
    }

    // Check if code has expired
    const now = new Date();
    const isExpired =
      user.emailVerificationCodeExpiry &&
      now > user.emailVerificationCodeExpiry;

    if (isExpired) {
      // Clear expired code if we have repository access
      if (userRepo) {
        user.emailVerificationCode = null;
        user.emailVerificationCodeExpiry = null;
        await userRepo.save(user);
      }

      throw new UnauthorizedException(
        'Verification code has expired. Please request a new verification code.',
      );
    }
  }

  /**
   * Set password for user who doesn't have one (OAuth users or email-only signups)
   * Guard ensures user has no password, but we double-check here for safety
   */
  async setPassword(
    userId: string,
    dto: SetPasswordDto,
  ): Promise<AuthResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Double-check: Guard should have already verified this, but safety check
      if (user.password) {
        throw new BadRequestException(
          'Password already exists. Use change-password endpoint instead.',
        );
      }

      // Hash and set the new password
      const hashedPassword = await this.passwordService.hashPassword(
        dto.password,
      );
      user.password = hashedPassword;
      // Set email as verified when password is set
      user.emailVerified = true;
      // Clear any pending verification codes since email is now verified
      user.emailVerificationCode = null;
      user.emailVerificationCodeExpiry = null;
      await userRepo.save(user);

      this.logger.log(
        `Password set successfully for user ${user.id}. Email verified. Returning JWT tokens.`,
      );

      // Return JWT tokens so user can login immediately
      return this.generateAuthResponse(
        user,
        manager,
        'Password set successfully',
      );
    });
  }

  /**
   * Change password for user who already has one
   * Requires current password verification
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<BaseResponseDto> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Check if user has a password
      if (!user.password) {
        throw new BadRequestException(
          'No password found. Use set-password endpoint instead.',
        );
      }

      // Check if new password is different from current password
      const isSamePassword = await this.passwordService.comparePassword(
        dto.newPassword,
        user.password,
      );

      if (isSamePassword) {
        throw new BadRequestException(
          'New password must be different from current password',
        );
      }

      // Hash and set the new password
      const hashedPassword = await this.passwordService.hashPassword(
        dto.newPassword,
      );
      user.password = hashedPassword;
      await userRepo.save(user);

      // Revoke all existing sessions so stolen tokens cannot be used after a password change
      await this.refreshTokenRepository.revokeAllForUser(user.id, manager);

      this.logger.log(
        `Password changed successfully for user ${user.id}. All refresh tokens revoked.`,
      );

      return {
        success: true,
        message: 'Password has been changed successfully',
      };
    });
  }
}
