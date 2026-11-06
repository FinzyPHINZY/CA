import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({
    description: 'Project title',
    example: 'My New Project',
    maxLength: 255,
    required: true,
  })
  @IsNotEmpty({ message: 'Title is required' })
  @IsString({ message: 'Title must be a string' })
  @MaxLength(255, { message: 'Title must not exceed 255 characters' })
  title: string;

  @ApiProperty({
    description: 'Project description',
    example: 'A detailed description of the project',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'Description must be a string' })
  description?: string;
}
