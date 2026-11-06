import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateSoloSessionDto {
  @ApiProperty({
    description: 'Project ID for the solo recording',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4', { message: 'Project ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Project ID is required' })
  projectId: string;

  @ApiProperty({
    description: 'Script ID for the solo recording',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4', { message: 'Script ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Script ID is required' })
  scriptId: string;

  @ApiProperty({
    description: 'Scene ID for the solo recording',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4', { message: 'Scene ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Scene ID is required' })
  sceneId: string;

  @ApiProperty({
    description: 'Optional rehearsal ID to associate with',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: 'Rehearsal ID must be a valid UUID' })
  rehearsalId?: string;
}
