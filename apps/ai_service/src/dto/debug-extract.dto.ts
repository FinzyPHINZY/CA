import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DebugExtractDto {
  @ApiProperty({
    description: 'Direct URL to the script media asset',
    example: 'https://s3.amazonaws.com/bucket/scripts/pilot.pdf',
  })
  @IsString()
  @IsNotEmpty()
  mediaUrl!: string;

  @ApiPropertyOptional({
    description: 'Original media file name (used for extension detection)',
    example: 'pilot.pdf',
  })
  @IsOptional()
  @IsString()
  fileName?: string;
}
