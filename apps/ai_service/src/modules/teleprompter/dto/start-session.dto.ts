import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

/**
 * Payload for the WebSocket `session.start` event. Settings here are frozen
 * for the session lifetime — to change modes mid-session the FE must end and
 * re-start.
 */
export class StartTeleprompterSessionDto {
  rehearsalId: string;

  @ApiPropertyOptional({
    description:
      'Cue detection mode. AUTO uses cursor + jaccard cue engine with silence fallback. MANUAL bypasses cue detection — FE advances via `manual:advance`.',
    enum: ['AUTO', 'MANUAL'],
    default: 'AUTO',
  })
  @IsOptional()
  @IsEnum(['AUTO', 'MANUAL'])
  detectionMode?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({
    description:
      'Silence-advance pacing. Affects how long the silence detector waits before treating a pause as line completion.',
    enum: ['fast', 'normal', 'patient'],
    default: 'normal',
  })
  @IsOptional()
  @IsEnum(['fast', 'normal', 'patient'])
  silencePace?: 'fast' | 'normal' | 'patient';

  @ApiPropertyOptional({
    description:
      'When true, scene action elements (e.g. "[she enters with a knife]") are emitted as `action.display` events with a 2s auto-advance. When false (default), action elements are stripped from the sequence entirely — FE renders only dialogue + parentheticals.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeActions?: boolean;
}
