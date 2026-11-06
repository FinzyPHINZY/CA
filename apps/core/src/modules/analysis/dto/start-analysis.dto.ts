import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class StartAnalysisDto {
  @ApiProperty({
    description: 'ID of the script to analyze',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID('4', { message: 'Script ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Script ID is required' })
  scriptId: string;

  @ApiProperty({
    description: 'Content of the script to analyze',
    example: 'FADE IN:\n\nINT. OFFICE - DAY\n\nJOHN sits at his desk...',
  })
  @IsString({ message: 'Script content must be a string' })
  @IsNotEmpty({ message: 'Script content is required' })
  scriptContent: string;
}
