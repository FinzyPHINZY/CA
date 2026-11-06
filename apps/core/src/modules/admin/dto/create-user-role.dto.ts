import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateUserRoleDto {
  @ApiProperty({ example: 'support_admin' })
  @IsString()
  @MaxLength(100)
  code: string;

  @ApiProperty({ example: 'Support Admin' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isSystem?: boolean;
}
