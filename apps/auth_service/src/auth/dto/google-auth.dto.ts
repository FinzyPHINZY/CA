import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class GoogleAuthDto {
  @ApiProperty({
    description:
      'Google ID token (JWT) or access token obtained from Google Sign-In. The service automatically detects the token type. ID tokens are JWTs (3 parts separated by dots), while access tokens are opaque strings starting with "ya29.". Both are supported.',
    example:
      'eyJhbGciOiJSUzI1NiIsImtpZCI6IjE2NzM4OTk2MzIiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJhenAiOiIxMjM0NTY3ODkwIiwiYXVkIjoiMTIzNDU2Nzg5MCIsInN1YiI6IjEyMzQ1Njc4OTAiLCJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwibmFtZSI6IkpvaG4gRG9lIiwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FBY0hUdG1tQ0FBRCIsImdpdmVuX25hbWUiOiJKb2huIiwiZmFtaWx5X25hbWUiOiJEb2UiLCJpYXQiOjE2NDAwMDAwMDAsImV4cCI6MTY0MDAwMzYwMH0...',
  })
  @IsString({ message: 'Token must be a string' })
  @IsNotEmpty({ message: 'Token is required' })
  accessToken: string; // Can be either ID token (JWT) or access token
}
