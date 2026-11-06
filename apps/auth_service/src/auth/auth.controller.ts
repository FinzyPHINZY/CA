/** biome-ignore-all lint/style/useImportType: <> */

import { BaseResponseDto } from '@app/common';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { LocalJwtAuthGuard } from '../users/guards/local-jwt-auth.guard';
import { SystemAdminGuard } from '../users/guards/system-admin.guard';
import { NoPasswordAuthGuard } from '../users/guards/no-password-auth.guard';
import { AuthService } from './auth.service';
import { AppleAuthDto } from './dto/apple-auth.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { EmailLoginDto } from './dto/email-login.dto';
import { EmailSignupDto } from './dto/email-signup.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { DeactivateUserDto } from './dto/deactivate-user.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { IsOptional, IsString } from 'class-validator';

class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
import { ResendVerificationCodeDto } from './dto/resend-verification-code.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { CreateAppAdminDto } from './dto/create-app-admin.dto';
import { SetAdminPermissionsDto } from './dto/set-admin-permissions.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern('auth.validateToken')
  async validateToken(@Payload() data: { token: string }) {
    return this.authService.validateAccessToken(data?.token);
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new user account via email and password',
    description:
      'Registers a new user account with email and optional password. If password is not provided during signup, the user will need to verify their email first and can set a password later. A verification code will be sent to the provided email address. The user must verify their email using the verify-code endpoint before they can fully use the account.',
  })
  @ApiBody({
    description:
      'User registration information including email, optional password, full name, phone number, and role',
    type: EmailSignupDto,
  })
  @ApiCreatedResponse({
    description:
      'User registered successfully. A verification code has been sent to the email address. Returns JWT tokens and user information.',
    type: AuthResponseDto,
  })
  @ApiConflictResponse({
    description:
      'A user with the provided email or phone number already exists. If the user exists but email is not verified, a new verification code will be sent and the user must verify their email before proceeding.',
    schema: {
      example: {
        success: false,
        message:
          'An account with this email already exists but is not verified. A new verification code has been sent to your email. Please verify your email using the code at POST /auth/verify-code, then set your password at POST /auth/set-password.',
        statusCode: 409,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Submitted signup payload failed validation. Common issues: invalid email format, password too short, invalid role, or missing required fields.',
    schema: {
      example: {
        success: false,
        message: 'email must be an email',
        statusCode: 400,
        errors: [
          'email must be an email',
          'password must be longer than or equal to 8 characters',
        ],
      },
    },
  })
  async signup(
    @Body(ValidationPipe) signupDto: EmailSignupDto,
  ): Promise<AuthResponseDto> {
    return this.authService.signupWithEmail(signupDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Authenticate an existing user via email/password or phone/password',
    description:
      'Authenticates a user using their email or phone number along with their password. Returns JWT access and refresh tokens upon successful authentication. The access token should be included in subsequent API requests in the Authorization header as "Bearer <token>". Note: Phone number login uses password authentication only - OTP/verification codes are EMAIL-ONLY and are not used for phone number login.',
  })
  @ApiBody({
    description:
      'Login credentials. Either email or phoneNumber must be provided along with password.',
    type: EmailLoginDto,
  })
  @ApiOkResponse({
    description:
      'Authentication successful. Returns JWT access token, refresh token, and user information. The access token expires in 15 minutes by default, and the refresh token expires in 7 days.',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid credentials supplied. This could mean: incorrect password, user not found, or account does not have a password set (use OAuth login instead).',
    schema: {
      example: {
        success: false,
        message: 'Invalid credentials',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request body. Either email or phoneNumber must be provided, and password is required.',
    schema: {
      example: {
        success: false,
        message: 'email or phoneNumber must be provided',
        statusCode: 400,
        errors: [
          'email or phoneNumber must be provided',
          'password must be longer than or equal to 8 characters',
        ],
      },
    },
  })
  async login(
    @Body(ValidationPipe) loginDto: EmailLoginDto,
  ): Promise<AuthResponseDto> {
    return this.authService.loginWithEmail(loginDto);
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Authenticate a user with Google Sign-In',
    description:
      "Authenticates a user using Google Sign-In OAuth 2.0. This endpoint accepts a Google ID token (JWT) obtained from the Google Sign-In JavaScript library (web) or Google Sign-In SDK (mobile). The ID token is verified against Google's servers to ensure authenticity. If the user does not exist, a new account will be automatically created with the information from their Google account. If a user with the same email already exists, their Google ID will be linked to the existing account. Users who sign up via Google OAuth do not have a password by default and can optionally set one using the set-password endpoint.",
  })
  @ApiBody({
    description:
      'Google ID token (JWT) from Google Sign-In. This is the credential.idToken returned by the Google Sign-In flow. Important: Use the ID token, not the access token. The ID token contains user information and is signed by Google.',
    type: GoogleAuthDto,
  })
  @ApiOkResponse({
    description:
      'Google account verified successfully. Returns JWT access and refresh tokens along with user information. The user account is automatically created if it does not exist, or linked to an existing account if the email matches.',
    type: AuthResponseDto,
    schema: {
      type: 'object',
      properties: {
        accessToken: {
          type: 'string',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMzQ1Njc4OTAiLCJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6IkFDVE9SIiwiaWF0IjoxNjQwMDAwMDAwLCJleHAiOjE2NDAwMDkwMDB9...',
        },
        refreshToken: {
          type: 'string',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMzQ1Njc4OTAiLCJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6IkFDVE9SIiwiaWF0IjoxNjQwMDAwMDAwLCJleHAiOjE2NDA2MDAwMDB9...',
        },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1234567890' },
            email: { type: 'string', example: 'user@example.com' },
            fullName: { type: 'string', example: 'John Doe' },
            emailVerified: { type: 'boolean', example: true },
            avatar: {
              type: 'string',
              example: 'https://lh3.googleusercontent.com/a/default',
            },
            role: { type: 'string', example: 'ACTOR' },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'The provided Google ID token is invalid, expired, or could not be verified. Common causes: using an access token instead of ID token, token has expired, token was issued for a different client ID, or Google OAuth is not properly configured on the server.',
    schema: {
      example: {
        success: false,
        message: 'Failed to verify Google ID token: Invalid token',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request body or missing required fields. The accessToken field (which should contain the Google ID token) is required.',
    schema: {
      example: {
        success: false,
        message: 'ID token is required',
        statusCode: 400,
        errors: ['ID token is required', 'ID token must be a string'],
      },
    },
  })
  async authenticateWithGoogle(
    @Body(ValidationPipe) googleAuthDto: GoogleAuthDto,
  ): Promise<AuthResponseDto> {
    return this.authService.authenticateWithGoogle(googleAuthDto);
  }

  @Post('apple')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Authenticate a user with Sign in with Apple',
    description:
      "Authenticates a user using Apple's Sign in with Apple OAuth service. This endpoint accepts an Apple identity token (JWT) and authorization code obtained from Apple after successful authentication. The identity token is verified to ensure it was issued by Apple. If the user does not exist, a new account will be automatically created with the information from their Apple account. If a user with the same email already exists, their Apple ID will be linked to the existing account. Users who sign up via Apple OAuth do not have a password by default and can optionally set one using the set-password endpoint. Note: Apple may not always provide the email address on subsequent sign-ins for privacy reasons.",
  })
  @ApiBody({
    description:
      'Apple authentication credentials. The identityToken is a JWT containing user information, and the authorizationCode is used for additional verification. Both are obtained from Apple after successful Sign in with Apple authentication.',
    type: AppleAuthDto,
  })
  @ApiOkResponse({
    description:
      'Apple identity verified successfully. Returns JWT access and refresh tokens along with user information. The user account is automatically created if it does not exist, or linked to an existing account if the email matches.',
    type: AuthResponseDto,
    schema: {
      type: 'object',
      properties: {
        accessToken: {
          type: 'string',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMzQ1Njc4OTAiLCJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6IlJFQURFUiIsImlhdCI6MTY0MDAwMDAwMCwiZXhwIjoxNjQwMDA5MDAwfQ...',
        },
        refreshToken: {
          type: 'string',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMzQ1Njc4OTAiLCJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6IlJFQURFUiIsImlhdCI6MTY0MDAwMDAwMCwiZXhwIjoxNjQwNjAwMDAwfQ...',
        },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1234567890.1234567890.1234567890' },
            email: { type: 'string', example: 'user@example.com' },
            fullName: { type: 'string', example: 'John Doe' },
            emailVerified: { type: 'boolean', example: true },
            role: { type: 'string', example: 'READER' },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'Provided Apple credentials could not be verified. Common causes: invalid identity token format, missing user ID in token, token expired, or Apple authentication is not properly configured on the server.',
    schema: {
      example: {
        success: false,
        message: 'Failed to verify Apple token',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request body or missing required fields. Both identityToken and authorizationCode are required.',
    schema: {
      example: {
        success: false,
        message: 'Identity token is required',
        statusCode: 400,
        errors: [
          'Identity token is required',
          'Authorization code is required',
        ],
      },
    },
  })
  async authenticateWithApple(
    @Body(ValidationPipe) appleAuthDto: AppleAuthDto,
  ): Promise<AuthResponseDto> {
    return this.authService.authenticateWithApple(appleAuthDto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request password reset code (OTP) via email',
    description:
      "Sends a 6-digit verification code (OTP) to the user's EMAIL address to reset their password. This endpoint is used when a user has forgotten their password. The verification code expires in 10 minutes and can be used with the verify-code endpoint to verify the email, after which the user can set a new password. This endpoint only works for users who have a password set (i.e., not for users who signed up via OAuth without setting a password). Note: Verification codes (OTP) are EMAIL-ONLY and are never sent via SMS or phone.",
  })
  @ApiBody({
    description:
      'User email address. The user must exist and have a password set on their account.',
    type: ForgotPasswordDto,
  })
  @ApiOkResponse({
    description:
      "Password reset code generated and sent successfully to the user's email address. The code expires in 10 minutes. Use the verify-code endpoint to verify the code, then the user can set a new password.",
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Password reset code has been sent to your email',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'User not found with the provided email address. Ensure the email matches the one used during signup.',
    schema: {
      example: {
        success: false,
        message: 'User not found',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Account uses social login (Google/Apple) and has no password set. These users should use OAuth to sign in, or set a password first using the set-password endpoint. Also returned for invalid email format.',
    schema: {
      example: {
        success: false,
        message:
          'This account uses social login. Please use Google or Apple to sign in.',
        statusCode: 400,
      },
    },
  })
  async forgotPassword(
    @Body(ValidationPipe) forgotPasswordDto: ForgotPasswordDto,
  ): Promise<BaseResponseDto> {
    return this.authService.forgotPassword(forgotPasswordDto.email);
  }

  @Post('resend-verification-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend verification code (OTP) via email',
    description:
      "Generates a new 6-digit verification code (OTP) and sends it to the user's EMAIL address. This endpoint is useful when the original verification code has expired (codes expire after 10 minutes) or was not received. The new code replaces the previous one and has a new 10-minute expiration timer. This endpoint can only be used for users whose email is not yet verified. Note: Verification codes (OTP) are EMAIL-ONLY and are never sent via SMS or phone.",
  })
  @ApiBody({
    description:
      'User email address. The user must exist and have an unverified email address.',
    type: ResendVerificationCodeDto,
  })
  @ApiOkResponse({
    description:
      "New verification code generated and sent successfully to the user's email address. The code expires in 10 minutes.",
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Verification code has been sent to your email',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'User not found with the provided email address. Ensure the email matches the one used during signup.',
    schema: {
      example: {
        success: false,
        message: 'User not found',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Email is already verified (no need to resend code), invalid email format, or validation failed.',
    schema: {
      example: {
        success: false,
        message: 'Email is already verified',
        statusCode: 400,
      },
    },
  })
  async resendVerificationCode(
    @Body(ValidationPipe) resendDto: ResendVerificationCodeDto,
  ): Promise<BaseResponseDto> {
    return this.authService.resendVerificationCode(resendDto.email);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify email with verification code (OTP)',
    description:
      "Validates the 6-digit verification code (OTP) sent to the user's EMAIL address during signup. If valid, JWT access and refresh tokens are returned. For users who signed up WITHOUT a password (email-only), they must use these tokens to call POST /auth/set-password before they can login. For users WITH a password, they can login immediately. Codes expire after 10 minutes and can only be used once.",
  })
  @ApiBody({
    description:
      'Email address and 6-digit verification code. The code must match the one sent to the email and must not be expired.',
    type: VerifyCodeDto,
  })
  @ApiOkResponse({
    description:
      'Email verified successfully. JWT access and refresh tokens are returned. Users without passwords must use these tokens to call POST /auth/set-password before they can login.',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid verification code, code expired (codes expire after 10 minutes), or user not found with the provided email address.',
    schema: {
      example: {
        success: false,
        message: 'Invalid or expired verification code',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Email already verified, no verification code found, or validation failed (invalid email format or code format).',
    schema: {
      example: {
        success: false,
        message: 'Email is already verified',
        statusCode: 400,
      },
    },
  })
  async verifyCode(
    @Body(ValidationPipe) verifyCodeDto: VerifyCodeDto,
  ): Promise<AuthResponseDto> {
    return this.authService.verifyCode(verifyCodeDto.email, verifyCodeDto.code);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh an access token using a valid refresh token',
    description:
      'Exchanges a valid refresh token for a new access token and refresh token pair. This endpoint should be used when the access token has expired (typically after 15 minutes). The refresh token has a longer expiration time (typically 7 days) and can be used to obtain new access tokens without requiring the user to log in again. After a successful refresh, the old refresh token is invalidated and should be replaced with the new one.',
  })
  @ApiBody({
    description:
      'Refresh token obtained during the last authentication. This token is used to obtain new access and refresh tokens.',
    type: RefreshTokenDto,
  })
  @ApiOkResponse({
    description:
      'New access and refresh tokens issued successfully. The old refresh token is invalidated. Use the new tokens for subsequent API requests.',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid refresh token supplied. The token may be expired, malformed, or already used. The user will need to authenticate again using login or OAuth.',
    schema: {
      example: {
        success: false,
        message: 'Invalid refresh token',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request body. The refreshToken field is required and must be a valid string.',
    schema: {
      example: {
        success: false,
        message: 'refreshToken must be a string',
        statusCode: 400,
        errors: [
          'refreshToken must be a string',
          'refreshToken should not be empty',
        ],
      },
    },
  })
  async refreshToken(
    @Body(ValidationPipe) { refreshToken }: RefreshTokenDto,
  ): Promise<AuthResponseDto> {
    return this.authService.refreshToken(refreshToken);
  }

  @UseGuards(NoPasswordAuthGuard)
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Set password for users without one (OAuth or email-only signups)',
    description:
      'Sets a password for users who signed up via OAuth (Google/Apple) or email-only signup and do not have a password yet. Upon successful password creation, JWT access and refresh tokens are returned, allowing the user to login immediately. This endpoint can only be used if the user has no existing password.',
  })
  @ApiBody({
    description: 'New password to set',
    type: SetPasswordDto,
  })
  @ApiOkResponse({
    description:
      'Password set successfully. JWT access and refresh tokens are returned for immediate authentication.',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token, or user not found',
    schema: {
      example: {
        success: false,
        message: 'Invalid or missing authentication token',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Password already exists (use change-password instead) or validation failed',
    schema: {
      example: {
        success: false,
        message: 'Password already exists. Use change-password instead.',
        statusCode: 400,
      },
    },
  })
  async setPassword(
    @Req() req: any,
    @Body(ValidationPipe) dto: SetPasswordDto,
  ): Promise<AuthResponseDto> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException(
        'User ID not found in request. Ensure a valid access token is sent.',
      );
    }
    return this.authService.setPassword(userId, dto);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change password for authenticated user',
    description:
      'Changes the password for users who already have a password. Requires verification of the current password.',
  })
  @ApiBody({
    description: 'Current password and new password',
    type: ChangePasswordDto,
  })
  @ApiOkResponse({
    description: 'Password changed successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Password has been changed successfully',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid or missing authentication token, incorrect current password, or user not found',
    schema: {
      example: {
        success: false,
        message: 'Incorrect current password',
        statusCode: 401,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'No password found (use set-password instead), new password same as current, or validation failed',
    schema: {
      example: {
        success: false,
        message: 'No password found. Use set-password instead.',
        statusCode: 400,
      },
    },
  })
  async changePassword(
    @Req() req: any,
    @Body(ValidationPipe) dto: ChangePasswordDto,
  ): Promise<BaseResponseDto> {
    const userId = req.user?.id;
    return this.authService.changePassword(userId, dto);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Logout user and invalidate refresh token',
    description:
      'Logs out the authenticated user by clearing their refresh token from the database. After logout, the refresh token cannot be used to obtain new access tokens. The user will need to log in again to get a new refresh token. This endpoint requires a valid access token in the Authorization header.',
  })
  @ApiOkResponse({
    description:
      'User logged out successfully. Refresh token has been invalidated.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example:
            'Logged out successfully. Refresh token has been invalidated.',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid or missing authentication token, or user not found. The access token must be valid and included in the Authorization header as "Bearer <token>".',
    schema: {
      example: {
        success: false,
        message: 'Authentication token is missing',
        statusCode: 401,
      },
    },
  })
  async logout(
    @Req() req: any,
    @Body() dto: LogoutDto,
  ): Promise<BaseResponseDto> {
    return this.authService.logout(req.user?.id, dto?.refreshToken);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Terminate all active sessions for the authenticated user',
    description:
      'Revokes every active refresh token for the current user, forcing all devices to re-authenticate.',
  })
  @ApiOkResponse({
    description: 'All sessions terminated.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'All sessions have been terminated.',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async logoutAll(@Req() req: any): Promise<BaseResponseDto> {
    return this.authService.logoutAll(req.user?.id);
  }

  @UseGuards(LocalJwtAuthGuard, SystemAdminGuard)
  @Post('admin/create-app-admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a new app admin user (system admin only)',
    description:
      'Creates a new user with the app admin role. A temporary password is generated and sent to the provided email address via the notification service. The new admin can sign in on the "Get started" screen using that email and the temporary password. Only system administrators can call this endpoint.',
  })
  @ApiBody({
    description:
      'Email, optional display name, and optional permissions (only system admins can grant permissions). Valid permissions: user_view, user_deactivate, user_ban, subscription_view, subscription_edit, project_view, project_edit, project_delete, access_flagged_content, content_moderate, content_delete, billing_view, billing_edit.',
    type: CreateAppAdminDto,
  })
  @ApiCreatedResponse({
    description: 'App admin account created; temporary password sent by email.',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example:
            'App admin account created. A temporary password has been sent to the provided email address.',
        },
        email: { type: 'string', example: 'admin@example.com' },
      },
    },
  })
  @ApiConflictResponse({
    description: 'A user with this email already exists.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 409 },
        message: {
          type: 'string',
          example:
            'A user with this email already exists. Use a different email.',
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a system administrator.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'Only system administrators can perform this action',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async createAppAdmin(
    @Req() req: any,
    @Body(ValidationPipe) dto: CreateAppAdminDto,
  ): Promise<{ message: string; email: string }> {
    const requestedByUserId = req.user?.id;
    const requestContext = {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    };
    return this.authService.createAppAdminUser(
      dto,
      requestedByUserId,
      requestContext,
    );
  }

  @UseGuards(LocalJwtAuthGuard, SystemAdminGuard)
  @Patch('admin/users/:userId/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Set app admin permissions (system admin only)',
    description:
      "Updates the granular permissions for an app admin (Support Admin) user. Only system administrators can grant or change permissions. Replaces the target user's existing permissions.",
  })
  @ApiParam({ name: 'userId', description: 'Target app admin user ID (UUID)' })
  @ApiBody({ type: SetAdminPermissionsDto })
  @ApiOkResponse({
    description: 'Permissions updated successfully',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Permissions updated successfully',
        },
        userId: { type: 'string', format: 'uuid' },
        permissions: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Target user is not an app admin',
  })
  @ApiForbiddenResponse({ description: 'Caller is not a system administrator' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async setAdminPermissions(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(ValidationPipe) dto: SetAdminPermissionsDto,
  ): Promise<{ message: string; userId: string; permissions: string[] }> {
    const requestedByUserId = req.user?.id;
    const requestContext = {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    };
    return this.authService.setAdminPermissions(
      userId,
      dto.permissions,
      requestedByUserId,
      requestContext,
    );
  }

  @UseGuards(LocalJwtAuthGuard)
  @Patch('admin/users/:userId/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Deactivate a user (system admin or permitted app admin)',
    description:
      'Deactivates a user account. Allowed for system_admin, or app_admin with user_deactivate permission.',
  })
  @ApiParam({ name: 'userId', description: 'Target user ID (UUID)' })
  @ApiBody({ type: DeactivateUserDto })
  @ApiOkResponse({
    description: 'User deactivated successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'User deactivated successfully' },
        userId: { type: 'string', format: 'uuid' },
        disabled: { type: 'boolean', example: true },
        reason: {
          type: 'string',
          nullable: true,
          example: 'Violation of platform policy',
        },
        actionTime: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Target user not found' })
  @ApiForbiddenResponse({
    description:
      'Caller is neither system_admin nor app_admin with user_deactivate permission',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async deactivateUser(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(ValidationPipe) dto: DeactivateUserDto,
  ): Promise<{
    message: string;
    userId: string;
    disabled: boolean;
    reason: string | null;
    actionTime: string | null;
  }> {
    const requestContext = {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    };
    return this.authService.deactivateUser(
      userId,
      {
        id: req.user?.id,
        roles: req.user?.roles ?? [],
        permissions: req.user?.permissions ?? [],
      },
      dto.reason,
      requestContext,
    );
  }

  @UseGuards(LocalJwtAuthGuard)
  @Patch('admin/users/:userId/ban')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Ban a user (system admin or permitted app admin)',
    description:
      'Bans a user account permanently. The user will be soft-deleted and cannot sign in. An email is sent to the user with the ban notification. Allowed for system_admin, or app_admin with user_ban permission.',
  })
  @ApiParam({ name: 'userId', description: 'Target user ID (UUID)' })
  @ApiBody({ type: BanUserDto })
  @ApiOkResponse({
    description: 'User banned successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'User banned successfully' },
        userId: { type: 'string', format: 'uuid' },
        banned: { type: 'boolean', example: true },
        reason: {
          type: 'string',
          nullable: true,
          example: 'Violation of community guidelines',
        },
        bannedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Target user not found' })
  @ApiForbiddenResponse({
    description:
      'Caller is neither system_admin nor app_admin with user_ban permission',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async banUser(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(ValidationPipe) dto: BanUserDto,
  ): Promise<{
    message: string;
    userId: string;
    banned: boolean;
    reason: string | null;
    bannedAt: string | null;
  }> {
    const requestContext = {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    };
    return this.authService.banUser(
      userId,
      {
        id: req.user?.id,
        roles: req.user?.roles ?? [],
        permissions: req.user?.permissions ?? [],
      },
      dto.reason,
      requestContext,
    );
  }

  @UseGuards(LocalJwtAuthGuard)
  @Patch('admin/users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Reactivate a user (system admin or permitted app admin)',
    description:
      'Reactivates a disabled user account. Allowed for system_admin, or app_admin with user_deactivate permission.',
  })
  @ApiParam({ name: 'userId', description: 'Target user ID (UUID)' })
  @ApiBody({ type: DeactivateUserDto })
  @ApiOkResponse({
    description: 'User reactivated successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'User reactivated successfully' },
        userId: { type: 'string', format: 'uuid' },
        disabled: { type: 'boolean', example: false },
        reason: {
          type: 'string',
          nullable: true,
          example: 'Appeal accepted after manual review',
        },
        actionTime: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Target user not found' })
  @ApiForbiddenResponse({
    description:
      'Caller is neither system_admin nor app_admin with user_deactivate permission',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing access token' })
  async reactivateUser(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(ValidationPipe) dto: DeactivateUserDto,
  ): Promise<{
    message: string;
    userId: string;
    disabled: boolean;
    reason: string | null;
    actionTime: string | null;
  }> {
    const requestContext = {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    };
    return this.authService.reactivateUser(
      userId,
      {
        id: req.user?.id,
        roles: req.user?.roles ?? [],
        permissions: req.user?.permissions ?? [],
      },
      dto.reason,
      requestContext,
    );
  }
}
