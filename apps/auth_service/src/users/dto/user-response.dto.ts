/** biome-ignore-all lint/style/useImportType: <> */

import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class UserDataDto {
  @ApiProperty({ description: 'User ID', example: 'uuid' })
  id: string;

  @ApiProperty({ description: 'User email', example: 'user@example.com' })
  email: string;

  @ApiProperty({
    description: 'Full name',
    example: 'John Doe',
    nullable: true,
  })
  fullName: string | null;

  @ApiProperty({
    description: 'Phone number',
    example: '+1234567890',
    nullable: true,
  })
  phoneNumber: string | null;

  @ApiProperty({
    description: 'User roles',
    example: ['ACTOR'],
    type: [String],
  })
  roles: string[];

  @ApiProperty({
    description: 'Avatar URL',
    example: 'https://example.com/avatar.jpg',
    nullable: true,
  })
  avatar: string | null;

  @ApiProperty({
    description: 'User bio',
    example: 'Experienced actor with a passion for dramatic roles',
    nullable: true,
  })
  bio: string | null;

  @ApiProperty({
    description: 'Years of experience',
    example: 5,
    nullable: true,
  })
  yearsOfExperience: number | null;

  @ApiProperty({
    description: 'User timezone',
    example: 'UTC',
  })
  timezone: string;

  @ApiProperty({
    description: 'User genres',
    example: ['Drama', 'Comedy'],
    type: [String],
  })
  genres: string[];

  @ApiProperty({
    description: 'Whether email is verified',
    example: true,
  })
  emailVerified: boolean;

  @ApiProperty({
    description: 'Account creation date',
    type: String,
    format: 'date-time',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update date',
    type: String,
    format: 'date-time',
  })
  updatedAt: Date;
}

export class UserResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'User profile data',
    type: UserDataDto,
  })
  @Type(() => UserDataDto)
  data: UserDataDto;
}
