/** biome-ignore-all lint/style/useImportType: <> */

import { MaterialType } from '@app/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateMaterialDto {
  @ApiProperty({
    enum: MaterialType,
    description: 'Type of material: file, link, or text',
    example: MaterialType.LINK,
  })
  @IsEnum(MaterialType)
  type: MaterialType;

  @ApiProperty({
    description: 'Display title for the material',
    example: 'Character Reference Sheet',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  // --- LINK type ---

  @ApiPropertyOptional({
    description: 'URL for link materials. Required when type is "link".',
    example: 'https://example.com/reference',
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  url?: string;

  // --- TEXT type ---

  @ApiPropertyOptional({
    description:
      'Text body for copy-paste text materials. Required when type is "text".',
    example: 'My character is a 35-year-old detective with a troubled past...',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  textContent?: string;

  // --- FILE type ---

  @ApiPropertyOptional({
    description:
      'S3 key returned by file_service after upload. Required when type is "file".',
    example: 'uploads/abc123/reference.pdf',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fileKey?: string;

  @ApiPropertyOptional({
    description:
      'Full file URL returned by file_service after upload. Required when type is "file".',
    example: 'https://s3.amazonaws.com/bucket/uploads/abc123/reference.pdf',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fileUrl?: string;

  @ApiPropertyOptional({
    description: 'Original filename. Required when type is "file".',
    example: 'reference.pdf',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional({
    description: 'File size in bytes.',
    example: 204800,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;

  @ApiPropertyOptional({
    description: 'MIME type of the uploaded file.',
    example: 'application/pdf',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;
}
