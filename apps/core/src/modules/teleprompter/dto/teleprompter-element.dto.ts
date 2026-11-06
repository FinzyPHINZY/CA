import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TeleprompterElementDto {
  @ApiProperty({
    description: 'Element type',
    enum: ['dialogue', 'action', 'parenthetical'],
    example: 'dialogue',
  })
  type: 'dialogue' | 'action' | 'parenthetical';

  @ApiPropertyOptional({
    description: 'Character name (null for action lines)',
    example: 'JOHN',
  })
  characterName: string | null;

  @ApiPropertyOptional({
    description: 'Character ID (null for action lines)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  characterId: string | null;

  @ApiProperty({
    description: 'Lines of text for this element',
    example: ['How are you doing today?'],
  })
  lines: string[];

  @ApiProperty({
    description: "Whether this element belongs to the actor's character",
    example: true,
  })
  isActor: boolean;

  @ApiPropertyOptional({
    description: 'Page number this element originates from (when available)',
    example: 12,
  })
  page?: number | null;
}

export class TeleprompterSceneDto {
  @ApiProperty({ description: 'Scene ID' })
  sceneId: string;

  @ApiProperty({ description: 'Scene number' })
  sceneNumber: number;

  @ApiPropertyOptional({ description: 'Scene heading' })
  heading: string | null;

  @ApiProperty({
    description: 'Ordered teleprompter elements',
    type: [TeleprompterElementDto],
  })
  elements: TeleprompterElementDto[];

  @ApiPropertyOptional({
    description: 'Unique list of page numbers for this scene',
    type: [Number],
    example: [11, 12],
  })
  pages?: number[] | null;
}

export class TeleprompterMetadataDto {
  @ApiPropertyOptional({
    description: 'Warnings emitted during screenplay normalization',
    type: [String],
  })
  structuralWarnings?: string[];

  @ApiPropertyOptional({
    description:
      'Extraction source used for this script (adobe, document_ai, legacy)',
    example: 'adobe_pdf_extract',
  })
  extractionSource?: string | null;

  @ApiPropertyOptional({
    description:
      'Coverage ratio representing the percentage of pages parsed successfully',
    example: 0.92,
  })
  coverageRatio?: number | null;

  @ApiPropertyOptional({
    description: 'Pages detected during normalization',
    type: [Number],
    example: [1, 2, 3, 4],
  })
  parsedPages?: number[];

  @ApiPropertyOptional({
    description: 'Whether a dual-column screenplay layout was detected',
    example: false,
  })
  dualColumnDetected?: boolean | null;

  @ApiPropertyOptional({
    description: 'Number of header/footer lines removed during normalization',
    example: 8,
  })
  removedHeaderFooterLines?: number | null;

  @ApiPropertyOptional({
    description: 'Number of watermark-like lines removed during normalization',
    example: 2,
  })
  removedWatermarks?: number | null;
}
