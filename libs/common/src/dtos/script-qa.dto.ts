import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class AskQuestionDto {
  @ApiProperty({
    description: 'Question about the script',
    example: 'When does Sarah first appear?',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  question: string;

  @ApiPropertyOptional({
    description: 'Existing conversation ID to continue',
  })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

export class FeedbackDto {
  @ApiProperty({
    description: 'Feedback score: -1 (bad), 0 (neutral), 1 (good)',
    example: 1,
    minimum: -1,
    maximum: 1,
  })
  @IsInt()
  @Min(-1)
  @Max(1)
  score: number;
}

export class CitationDto {
  @ApiProperty({ example: 'uuid' })
  sceneId: string | null;

  @ApiProperty({ example: 3 })
  sceneNumber: number | null;

  @ApiProperty({ example: 4 })
  pageStart: number | null;

  @ApiProperty({ example: 5 })
  pageEnd: number | null;

  @ApiProperty({ example: 'INT. KITCHEN - DAY. SARAH walks in...' })
  snippet: string;
}

export class QaResponseDto {
  @ApiProperty({ example: 'uuid' })
  messageId: string;

  @ApiProperty({ example: 'uuid' })
  conversationId: string;

  @ApiProperty({ example: 'LOOKUP' })
  queryClass: string;

  @ApiProperty({ example: 'Sarah first appears in scene 3 [scene 3, p. 4].' })
  answer: string;

  @ApiProperty({ type: [CitationDto] })
  citations: CitationDto[];

  @ApiProperty({ example: 'gemini-2.0-flash' })
  model: string;

  @ApiProperty({ example: 1820 })
  latencyMs: number;

  @ApiProperty({ example: false })
  cached: boolean;

  @ApiProperty({ example: false })
  refused: boolean;

  @ApiPropertyOptional({ example: 'LOW_CONFIDENCE' })
  refusalReason?: string;
}
