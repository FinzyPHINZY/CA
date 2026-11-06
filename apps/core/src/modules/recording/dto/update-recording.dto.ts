import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsNumber,
  IsObject,
  IsUUID,
} from 'class-validator';
import { RecordingTypeEnum } from '@app/common';

export class UpdateRecordingDto {
  @ApiProperty({
    description: 'Title card for the recording',
    example: 'Scene 1 - Opening (Updated)',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'Title card must be a string' })
  titleCard?: string | null;

  @ApiProperty({
    description: 'Type of recording',
    enum: RecordingTypeEnum,
    example: RecordingTypeEnum.SOLO,
    required: false,
  })
  @IsOptional()
  @IsEnum(RecordingTypeEnum, { message: 'Invalid recording type' })
  type?: RecordingTypeEnum;

  @ApiProperty({
    description: 'Array of media IDs for recording takes',
    example: ['123e4567-e89b-12d3-a456-426614174000'],
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray({ message: 'Takes must be an array' })
  @IsUUID('4', { each: true, message: 'Each take ID must be a valid UUID' })
  takes?: string[];

  @ApiProperty({
    description: 'Array of media IDs for media resources',
    example: ['323e4567-e89b-12d3-a456-426614174002'],
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray({ message: 'Media resources must be an array' })
  @IsUUID('4', {
    each: true,
    message: 'Each media resource ID must be a valid UUID',
  })
  mediaResources?: string[];

  @ApiProperty({
    description: 'Summary of the recording',
    example: 'Updated summary of the recording',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'Summary must be a string' })
  summary?: string | null;

  @ApiProperty({
    description: 'Duration of the recording in milliseconds',
    example: 150000,
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsNumber({}, { message: 'Duration must be a number' })
  durationMs?: number | null;

  @ApiProperty({
    description: 'Additional metadata for the recording',
    example: { notes: 'Updated notes', quality: 'high', edited: true },
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsObject({ message: 'Metadata must be an object' })
  metaData?: Record<string, any> | null;
}
