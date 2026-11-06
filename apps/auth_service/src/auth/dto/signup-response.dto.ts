import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { AuthUserResponseDto } from './auth-response.dto';

export class SignupResponseDataDto {
  @ApiProperty({
    description: 'User information',
    type: AuthUserResponseDto,
  })
  @Type(() => AuthUserResponseDto)
  user: AuthUserResponseDto;
}

export class SignupResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Signup data including user information',
    type: SignupResponseDataDto,
  })
  @Type(() => SignupResponseDataDto)
  data: SignupResponseDataDto;
}
