import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class FlagProjectDto {
  @ApiPropertyOptional({
    description: 'Optional reason the project is being flagged',
    example: 'Contains harmful or inappropriate content',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
