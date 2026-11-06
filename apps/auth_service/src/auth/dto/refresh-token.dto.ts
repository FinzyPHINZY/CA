import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, IsNotEmpty } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'Valid refresh token issued during the last authentication flow. This token is used to obtain a new access token when the current one expires. Refresh tokens typically have a longer expiration time (e.g., 7 days) compared to access tokens.',
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMzQ1Njc4OTAiLCJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwicm9sZSI6IkFDVE9SIiwiaWF0IjoxNjQwMDAwMDAwLCJleHAiOjE2NDA2MDAwMDB9...',
    minLength: 10,
    required: true,
  })
  @IsString({ message: 'Refresh token must be a string' })
  @IsNotEmpty({ message: 'Refresh token is required' })
  @MinLength(10, { message: 'Refresh token appears to be invalid' })
  refreshToken: string;
}
