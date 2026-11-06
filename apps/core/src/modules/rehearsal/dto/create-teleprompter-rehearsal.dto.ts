import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

/**
 * Payload for creating a SOLO/TELEPROMPTER rehearsal. No partner type — the
 * teleprompter has no AI or human partner. `characterId` is display-only
 * metadata and is not enforced at runtime (cue detection is speaker-agnostic).
 */
export class CreateTeleprompterRehearsalDto {
  @ApiProperty({
    description:
      'Scene ID to read in the teleprompter. The scriptId and projectId are derived from the scene.',
    example: '323e4567-e89b-12d3-a456-426614174002',
    required: true,
  })
  @IsUUID('4', { message: 'Scene ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Scene ID is required' })
  sceneId: string;

  @ApiPropertyOptional({
    description:
      'Optional character ID the actor identifies with — display-only. The teleprompter does not gate advance by character; any speaker can advance any line.',
    example: '423e4567-e89b-12d3-a456-426614174003',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: 'Character ID must be a valid UUID' })
  characterId?: string;
}
