import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateScriptDto {
  @ApiProperty({
    description: 'Script title',
    example: 'Episode 1 - Pilot',
    minLength: 1,
    maxLength: 255,
  })
  @IsString({ message: 'title must be a string' })
  @IsNotEmpty({ message: 'title should not be empty' })
  @MaxLength(255, { message: 'title must not exceed 255 characters' })
  title: string;

  @ApiProperty({
    description: 'URL or path to the uploaded script file',
    example: 'https://storage.example.com/scripts/episode-1-pilot.pdf',
  })
  @IsString({ message: 'fileUrl must be a string' })
  @IsNotEmpty({ message: 'fileUrl should not be empty' })
  @IsUrl({}, { message: 'fileUrl must be a valid URL' })
  fileUrl: string;

  @ApiPropertyOptional({
    description:
      'Optional default character/role ID for this script. Must reference an existing character.',
    example: '333e4567-e89b-12d3-a456-426614174002',
  })
  @IsOptional()
  @IsUUID('4', { message: 'defaultCharacterId must be a UUID' })
  defaultCharacterId?: string;
}
