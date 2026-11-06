import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNotEmpty,
  IsArray,
  IsNumber,
  IsObject,
  ValidateNested,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RecordingTypeEnum } from '@app/common';

export class CreateRecordingDto {
  @ApiProperty({
    description: 'Title card for the recording',
    example: 'Scene 1 - Opening',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'Title card must be a string' })
  titleCard?: string | null;

  @ApiProperty({
    description: 'Type of recording',
    enum: RecordingTypeEnum,
    example: RecordingTypeEnum.AI_PARTNER,
    default: RecordingTypeEnum.AI_PARTNER,
  })
  @IsEnum(RecordingTypeEnum, { message: 'Invalid recording type' })
  @IsNotEmpty({ message: 'Recording type is required' })
  type: RecordingTypeEnum;

  @ApiProperty({
    description: 'Project ID that this recording belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: true,
  })
  @IsUUID('4', { message: 'Project ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Project ID is required' })
  projectId: string;

  @ApiProperty({
    description: 'Script ID that this recording belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: true,
  })
  @IsUUID('4', { message: 'Script ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Script ID is required' })
  scriptId: string;

  @ApiProperty({
    description: 'Scene ID that this recording belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: true,
  })
  @IsUUID('4', { message: 'Scene ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Scene ID is required' })
  sceneId: string;

  @ApiProperty({
    description: 'Array of media IDs for recording takes',
    example: [
      '123e4567-e89b-12d3-a456-426614174000',
      '223e4567-e89b-12d3-a456-426614174001',
    ],
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
    example: 'This is a recording of the opening scene',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'Summary must be a string' })
  summary?: string | null;

  @ApiProperty({
    description: 'Duration of the recording in milliseconds',
    example: 120000,
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsNumber({}, { message: 'Duration must be a number' })
  durationMs?: number | null;

  @ApiProperty({
    description: 'Additional metadata for the recording',
    example: { notes: 'First take', quality: 'high' },
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsObject({ message: 'Metadata must be an object' })
  metaData?: Record<string, any> | null;
}
