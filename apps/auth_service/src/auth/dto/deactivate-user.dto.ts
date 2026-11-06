import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DeactivateUserDto {
  @ApiProperty({
    description: 'Optional reason for account status change action',
    example: 'Violation of platform policy',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
