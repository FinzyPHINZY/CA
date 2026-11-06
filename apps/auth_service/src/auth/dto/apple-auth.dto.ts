import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class AppleAuthDto {
  @ApiProperty({
    description:
      'Apple identity token (JWT) obtained from Sign in with Apple. This is the identityToken returned by Apple after successful authentication. The token contains user information including email and user ID (sub).',
    example:
      'eyJraWQiOiJlWGF1bmRyMm1maW5nIiwiYWxnIjoiUlMyNTYifQ.eyJpc3MiOiJodHRwczovL2FwcGxlaWQuYXBwbGUuY29tIiwiYXVkIjoiY29tLmV4YW1wbGUuYXBwIiwiZXhwIjoxNjQwMDAwMDAwLCJpYXQiOjE2NDAwMDAwMDAsInN1YiI6IjEyMzQ1Njc4OTAuMTIzNDU2Nzg5MC4xMjM0NTY3ODkwIiwibm9uY2UiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiIsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJhdXRoX3RpbWUiOjE2NDAwMDAwMDB9...',
  })
  @IsString({ message: 'Identity token must be a string' })
  @IsNotEmpty({ message: 'Identity token is required' })
  identityToken: string;

  @ApiProperty({
    description:
      'Apple authorization code obtained from Sign in with Apple. This is the authorizationCode returned by Apple after successful authentication. Used for additional verification and token exchange.',
    example: 'c1234567890abcdef1234567890abcdef12345678',
  })
  @IsString({ message: 'Authorization code must be a string' })
  @IsNotEmpty({ message: 'Authorization code is required' })
  authorizationCode: string;
}
