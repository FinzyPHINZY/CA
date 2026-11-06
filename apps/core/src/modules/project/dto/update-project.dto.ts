import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  MaxLength,
  IsArray,
  IsUUID,
  ArrayMinSize,
} from 'class-validator';

export class UpdateProjectDto {
  @ApiProperty({
    description: 'Project title',
    example: 'Updated Project Title',
    maxLength: 255,
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'Title must be a string' })
  @MaxLength(255, { message: 'Title must not exceed 255 characters' })
  title?: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Updated project description',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'Description must be a string' })
  description?: string;

  @ApiProperty({
    description:
      'Deprecated compatibility field. Use POST /api/projects/:id/scripts instead. Array of new media IDs to add as scripts.',
    example: ['123e4567-e89b-12d3-a456-426614174000'],
    type: [String],
    required: false,
    deprecated: true,
  })
  @IsOptional()
  @IsArray({ message: 'Media IDs must be an array' })
  @ArrayMinSize(1, { message: 'At least one media ID is required if provided' })
  @IsUUID('4', { each: true, message: 'Each media ID must be a valid UUID' })
  newMediaIds?: string[];
}
