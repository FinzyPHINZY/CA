import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class EmailSignupDto {
  @ApiProperty({
    description: 'User email address. Must be a valid email format.',
    example: 'user@example.com',
    required: true,
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({
    description:
      'User password. Must be at least 8 characters long. Optional for initial signup (password can be set later).',
    example: 'SecurePassword123!',
    minLength: 8,
    required: false,
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @IsOptional()
  password?: string;

  @ApiProperty({
    description: "User's full name",
    example: 'John Doe',
    required: false,
  })
  @IsString()
  @IsOptional()
  fullName?: string;

  @ApiProperty({
    description: "User's phone number",
    example: '+1234567890',
    required: false,
  })
  @IsString()
  @IsOptional()
  phoneNumber?: string;

  @ApiProperty({
    description: 'User role code. Defaults to actor. Must exist in user_roles.',
    example: 'actor',
    required: false,
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiProperty({
    description:
      'IANA timezone string (e.g., America/New_York). Defaults to UTC.',
    example: 'America/New_York',
    required: false,
  })
  @IsString()
  @IsOptional()
  timezone?: string;
}
