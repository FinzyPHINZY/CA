import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class AuthUserResponseDto {
  @ApiProperty({
    description: 'Unique identifier of the user',
    example: '1234567890',
  })
  id: string;

  @ApiProperty({
    description: 'Email address of the user',
    example: 'user@example.com',
    nullable: true,
  })
  email?: string;

  @ApiProperty({
    description: 'Full name of the user',
    example: 'John Doe',
    nullable: true,
  })
  fullName?: string;

  @ApiProperty({
    description: 'Phone number of the user',
    example: '+1234567890',
    nullable: true,
  })
  phoneNumber?: string;

  @ApiProperty({
    description: 'Roles of the user in the system',
    example: ['actor'],
    type: [String],
  })
  roles: string[];

  @ApiProperty({
    description: 'Granular permissions resolved for the user',
    example: ['project_view', 'project_edit'],
    type: [String],
    required: false,
  })
  permissions?: string[];

  @ApiProperty({
    description: 'IANA timezone of the user',
    example: 'America/New_York',
  })
  timezone: string;

  @ApiProperty({
    description: 'URL of the user avatar image',
    example: 'https://example.com/avatar.png',
    nullable: true,
  })
  avatar?: string;

  @ApiProperty({
    description: 'Whether the user email has been verified',
    example: true,
  })
  emailVerified: boolean;

  @ApiProperty({
    description: 'Reason provided when account was deactivated',
    nullable: true,
    required: false,
    example: 'Violation of platform policy',
  })
  deactivationReason?: string | null;

  @ApiProperty({
    description: 'Timestamp when account was deactivated',
    nullable: true,
    required: false,
    example: '2026-02-28T11:45:00.000Z',
  })
  deactivatedAt?: Date | null;

  @ApiProperty({
    description: 'Reason provided when account was reactivated',
    nullable: true,
    required: false,
    example: 'Appeal accepted after manual review',
  })
  reactivationReason?: string | null;

  @ApiProperty({
    description: 'Timestamp when account was reactivated',
    nullable: true,
    required: false,
    example: '2026-03-01T09:30:00.000Z',
  })
  reactivatedAt?: Date | null;
}

export class AuthResponseDataDto {
  @ApiProperty({
    description: 'JWT access token used to authenticate API requests',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Refresh token that can be exchanged for new access tokens',
  })
  refreshToken: string;

  @ApiProperty({
    description: 'Authenticated user information',
    type: AuthUserResponseDto,
  })
  @Type(() => AuthUserResponseDto)
  user: AuthUserResponseDto;
}

export class AuthResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Authentication data including tokens and user information',
    type: AuthResponseDataDto,
  })
  @Type(() => AuthResponseDataDto)
  data: AuthResponseDataDto;
}
