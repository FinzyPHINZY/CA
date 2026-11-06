import {
  IsEmail,
  IsOptional,
  IsString,
  ValidateIf,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EmailLoginDto {
  @ApiProperty({
    description:
      'User email address. Required if phoneNumber is not provided. Either email or phoneNumber must be provided.',
    example: 'user@example.com',
    required: false,
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({
    description: 'User password. Required for authentication.',
    example: 'SecurePassword123!',
    minLength: 8,
    required: true,
  })
  @IsString({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password: string;
}
