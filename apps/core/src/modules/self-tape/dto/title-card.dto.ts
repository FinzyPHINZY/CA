import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TitleCardDto {
  @ApiProperty({
    description: 'Actor name displayed on the title card',
    example: 'Jane Smith',
  })
  @IsString()
  @IsNotEmpty()
  actorName: string;

  @ApiPropertyOptional({
    description: 'Agent or agency name',
    example: 'Creative Artists Agency',
  })
  @IsOptional()
  @IsString()
  agentName?: string;

  @ApiProperty({
    description: 'Scene name displayed on the title card',
    example: 'INT. OFFICE - DAY',
  })
  @IsString()
  @IsNotEmpty()
  sceneName: string;

  @ApiPropertyOptional({
    description: 'Custom text to display on the title card',
    example: 'Role: Detective Morgan',
  })
  @IsOptional()
  @IsString()
  customText?: string;
}
