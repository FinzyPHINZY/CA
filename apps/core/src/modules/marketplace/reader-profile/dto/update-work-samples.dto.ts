import { ReaderWorkSampleSourceType, WorkSampleType } from '@app/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class WorkSampleItemDto {
  @ApiProperty({
    description: 'Title of the work sample',
    example: 'Shakespeare Monologue Reel',
  })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    description:
      'Source type for the work sample. Uploaded samples must use `mediaId`; external samples must use `url`.',
    enum: ReaderWorkSampleSourceType,
    example: ReaderWorkSampleSourceType.UPLOAD,
  })
  @IsIn(Object.values(ReaderWorkSampleSourceType))
  sourceType: string;

  @ApiPropertyOptional({
    description:
      'Media ID of an uploaded work sample file. Required when `sourceType` is `upload`.',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'mediaId must be a valid UUID' })
  mediaId?: string;

  @ApiPropertyOptional({
    description:
      'URL to the work sample (YouTube, Vimeo, etc.). Required when `sourceType` is `external_link`.',
    example: 'https://www.youtube.com/watch?v=abc123',
  })
  @IsOptional()
  @IsUrl({}, { message: 'url must be a valid URL' })
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({
    description:
      'Thumbnail/preview image URL (pre-fetched by client via oEmbed or link-preview endpoint)',
    example: 'https://img.youtube.com/vi/abc123/hqdefault.jpg',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  thumbnailUrl?: string;

  @ApiProperty({
    description: 'Type of work sample',
    enum: WorkSampleType,
    example: WorkSampleType.VIDEO,
  })
  @IsIn(Object.values(WorkSampleType))
  type: string;
}

export class UpdateWorkSamplesDto {
  @ApiProperty({
    description: 'List of work samples / reels',
    type: [WorkSampleItemDto],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'At least one work sample is required' })
  @ValidateNested({ each: true })
  @Type(() => WorkSampleItemDto)
  samples: WorkSampleItemDto[];
}
