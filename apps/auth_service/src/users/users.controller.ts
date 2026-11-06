/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { BaseResponseDto } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateSelfDto } from './dto/update-self.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { AdminGuard } from './guards/admin.guard';
import { LocalJwtAuthGuard } from './guards/local-jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { UserPreferencesService } from './user-preferences.service';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly userPreferencesService: UserPreferencesService,
  ) {}

  @UseGuards(LocalJwtAuthGuard)
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current user profile',
    description:
      "Returns the authenticated user's profile information. This endpoint does not include sensitive fields such as password or refresh tokens.",
  })
  @ApiOkResponse({
    description: 'Current user profile retrieved successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiNotFoundResponse({
    description: 'User not found',
  })
  async getSelf(@Req() req: any) {
    const userId = req.user?.id;
    return this.usersService.getSelf(userId);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Get('me/permissions')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current user permissions',
    description:
      "Returns the authenticated user's permissions. System admins receive all admin permissions; app admins receive their assigned permissions; other users receive an empty array.",
  })
  @ApiOkResponse({
    description: 'User permissions retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Permissions retrieved successfully',
        },
        data: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: { type: 'string' },
              example: ['subscription_view', 'billing_view'],
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getSelfPermissions(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      return {
        success: true,
        message: 'Permissions retrieved successfully',
        data: { permissions: [] },
      };
    }
    const permissions = await this.authService.getPermissionsForUserId(userId);
    return {
      success: true,
      message: 'Permissions retrieved successfully',
      data: { permissions },
    };
  }

  @UseGuards(LocalJwtAuthGuard)
  @Patch('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update current user profile',
    description:
      "Updates the authenticated user's own profile information. All fields are optional. Only provided fields will be updated.",
  })
  @ApiBody({
    description: 'User profile update data. All fields are optional.',
    type: UpdateSelfDto,
  })
  @ApiOkResponse({
    description: 'User profile updated successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiBadRequestResponse({
    description: 'Invalid user data provided or validation failed',
  })
  async updateSelf(@Req() req: any, @Body(ValidationPipe) dto: UpdateSelfDto) {
    const userId = req.user?.id;
    return this.usersService.updateSelf(userId, dto);
  }

  @UseGuards(LocalJwtAuthGuard, AdminGuard)
  @Patch('me/admin')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update current user profile (admin only)',
    description:
      "Updates the authenticated admin user's own profile (e.g. full name, avatar, bio, timezone). Only users with the app admin or system admin role can use this endpoint. Same request body as PATCH /users/me.",
  })
  @ApiBody({
    description:
      'Profile fields to update. All fields optional (e.g. fullName for "What is your name?" flow).',
    type: UpdateSelfDto,
  })
  @ApiOkResponse({
    description: 'Admin profile updated successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'Caller is not an administrator (app admin or system admin)',
  })
  @ApiBadRequestResponse({
    description: 'Invalid user data provided or validation failed',
  })
  async updateSelfAsAdmin(
    @Req() req: any,
    @Body(ValidationPipe) dto: UpdateSelfDto,
  ) {
    const userId = req.user?.id;
    return this.usersService.updateSelf(userId, dto);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Delete current user account',
    description:
      'Soft deletes the authenticated user account and disables it from being able to login or perform any actions. This action cannot be undone.',
  })
  @ApiOkResponse({
    description: 'User account deleted successfully',
    type: BaseResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiNotFoundResponse({
    description: 'User not found',
  })
  async destroySelf(@Req() req: any): Promise<BaseResponseDto> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error(
        'User ID not found in request. Ensure JWT authentication is properly configured.',
      );
    }
    return this.usersService.destroySelf(userId);
  }

  @UseGuards(LocalJwtAuthGuard)
  @Get('me/preferences')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current user rehearsal preferences',
    description:
      "Returns the authenticated user's display preferences and default session settings, merged with system defaults.",
  })
  @ApiOkResponse({ description: 'Preferences retrieved successfully' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing token' })
  async getPreferences(@Req() req: any) {
    const data = await this.userPreferencesService.getPreferences(req.user?.id);
    return {
      success: true,
      message: 'Preferences retrieved successfully',
      data,
    };
  }

  @UseGuards(LocalJwtAuthGuard)
  @Patch('me/preferences')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Update current user rehearsal preferences',
    description:
      'Partial-updates display preferences and/or default session settings. Only provided fields are changed.',
  })
  @ApiBody({ type: UpdatePreferencesDto })
  @ApiOkResponse({ description: 'Preferences updated successfully' })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing token' })
  async updatePreferences(
    @Req() req: any,
    @Body(ValidationPipe) dto: UpdatePreferencesDto,
  ) {
    const data = await this.userPreferencesService.updatePreferences(
      req.user?.id,
      dto,
    );
    return {
      success: true,
      message: 'Preferences updated successfully',
      data,
    };
  }
}
