import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class VerifyCodeDto {
  @ApiProperty({
    description: 'User email address',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({
    description: '6-digit verification code sent to email',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @Length(6, 6, { message: 'Verification code must be exactly 6 digits' })
  @Matches(/^\d{6}$/, {
    message: 'Verification code must contain only digits',
  })
  code: string;
}
