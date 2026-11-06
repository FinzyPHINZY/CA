import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PasteScriptDto {
  @ApiProperty({
    description: 'Raw script text to analyze. Must be at least 200 characters.',
    example: 'FADE IN:\n\nINT. COFFEE SHOP - DAY\n\nJANE sits at a table...',
    minLength: 200,
    maxLength: 500_000,
  })
  @IsString()
  @IsNotEmpty({ message: 'Script text must not be empty' })
  @MinLength(200, {
    message: 'Script text must be at least 200 characters (about half a page)',
  })
  @MaxLength(500_000, {
    message: 'Script text must not exceed 500,000 characters (~250 pages)',
  })
  text: string;

  @ApiPropertyOptional({
    description: 'Optional title for the script. Auto-generated if omitted.',
    example: 'Coffee Shop Audition',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
