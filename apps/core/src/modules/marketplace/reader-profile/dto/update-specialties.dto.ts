import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn } from 'class-validator';
import { ReaderGenre } from '@app/common';

const VALID_GENRES = Object.values(ReaderGenre);

export class UpdateSpecialtiesDto {
  @ApiProperty({
    description: 'List of genres/specialties the reader focuses on',
    example: ['drama', 'comedy', 'thriller'],
    enum: ReaderGenre,
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'At least one specialty is required' })
  @IsIn(VALID_GENRES, {
    each: true,
    message: `Each genre must be one of: ${VALID_GENRES.join(', ')}`,
  })
  genres: string[];
}
