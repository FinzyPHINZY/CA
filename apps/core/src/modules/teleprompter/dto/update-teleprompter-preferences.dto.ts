import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsHexColor,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateTeleprompterPreferencesDto {
  @ApiPropertyOptional({
    description: 'Scroll speed in words per minute',
    minimum: 50,
    maximum: 300,
    example: 150,
  })
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(300)
  defaultScrollSpeed?: number;

  @ApiPropertyOptional({
    description: 'Font size in pixels',
    minimum: 14,
    maximum: 72,
    example: 32,
  })
  @IsOptional()
  @IsNumber()
  @Min(14)
  @Max(72)
  fontSize?: number;

  @ApiPropertyOptional({
    description: 'Enable blackout mode (hides non-active lines)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  blackoutMode?: boolean;

  @ApiPropertyOptional({
    description: 'Show action/stage direction lines',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  showActionLines?: boolean;

  @ApiPropertyOptional({
    description: 'Show parenthetical directions',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  showParentheticals?: boolean;

  @ApiPropertyOptional({
    description: "Highlight color for the actor's lines (hex)",
    example: '#FFD700',
  })
  @IsOptional()
  @IsString()
  @IsHexColor()
  highlightColor?: string;
}
