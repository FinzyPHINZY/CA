import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';

export class RequestExtensionDto {
  @ApiProperty({
    description: 'Extension duration in minutes',
    example: 15,
    enum: [15, 30],
  })
  @IsInt()
  @IsIn([15, 30])
  durationMinutes: number;
}

export class DeclineExtensionDto {
  @ApiPropertyOptional({ description: 'Reason for declining the extension' })
  @IsOptional()
  @IsString()
  reason?: string;
}
