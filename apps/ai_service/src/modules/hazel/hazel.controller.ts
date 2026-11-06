// hazelcontroller — REST endpoints for hazel session management.
// routes (all under /api/hazel):
//   GET  /voices                          (4.1.12)
//   POST /session/:rehearsalId/voices     (4.1.13)
//   POST /session/prepare                 (4.1.19)
//   GET  /session/:rehearsalId/prepare/status (4.1.20)
//   GET  /deepgram-token                  (4.1.22)

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  Query,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Request } from 'express';

import { ElevenLabsService } from './elevenlabs.service';
import { DeepgramService } from '../cue-engine/deepgram.service';
import { HazelSessionService } from './hazel-session.service';
import { HazelSceneLoaderService } from './hazel-scene-loader.service';
import { TurnSequenceBuilder } from './turn-sequence.builder';
import { VoiceMapperService } from './voice-mapper.service';
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import { HazelUsageMeterService } from './hazel-usage-meter.service';
import {
  CharacterRepository,
  RehearsalMode,
  RehearsalStatus,
  RehersalRepository,
} from '@app/common';
import { TurnSequencerService } from './turn-sequencer.service';
import { HazelEventLoggerService } from './hazel-event-logger.service';

const VOICES_CACHE_KEY = 'hazel:voices:cache';
const VOICES_CACHE_TTL = 60 * 60; // 1 hour

@ApiTags('Hazel')
@ApiBearerAuth('access-token')
@Controller('hazel')
export class HazelController {
  private readonly logger = new Logger(HazelController.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly elevenLabsService: ElevenLabsService,
    private readonly deepgramService: DeepgramService,
    private readonly sessionService: HazelSessionService,
    private readonly sceneLoader: HazelSceneLoaderService,
    private readonly sequenceBuilder: TurnSequenceBuilder,
    private readonly voiceMapper: VoiceMapperService,
    private readonly audioPregen: HazelAudioPreGenerationService,
    private readonly usageMeter: HazelUsageMeterService,
    private readonly characterRepository: CharacterRepository,
    private readonly rehersalRepository: RehersalRepository,
    private readonly sequencer: TurnSequencerService,
    private readonly eventLogger: HazelEventLoggerService,
  ) {}

  // GET /api/hazel/voices
  @Get('voices')
  @ApiOperation({
    summary: 'List available ElevenLabs voices',
    description:
      'Returns ElevenLabs voices available for Hazel character voice assignment. Results are cached for 1 hour. Use the optional `accent` query param to filter (e.g. `?accent=american`). Use the voiceId values when calling the voice-override endpoint.',
  })
  @ApiQuery({
    name: 'accent',
    required: false,
    type: String,
    description:
      'Filter voices by accent label (e.g. american, british, australian)',
    example: 'american',
  })
  @ApiOkResponse({
    description: 'List of available voices',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          voiceId: { type: 'string', example: 'TxGEqnHWrfWFTfGW9XjX' },
          name: { type: 'string', example: 'Josh' },
          description: { type: 'string', example: 'Young adult male' },
          previewAudioUrl: {
            type: 'string',
            example:
              'https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/preview.mp3',
          },
          labels: {
            type: 'object',
            properties: {
              gender: { type: 'string', example: 'male' },
              age: { type: 'string', example: 'young' },
              accent: { type: 'string', example: 'american' },
              useCase: { type: 'string', example: 'narration' },
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async listVoices(@Query('accent') accent?: string) {
    const cached = await this.redis.get(VOICES_CACHE_KEY);
    const voices = cached
      ? JSON.parse(cached)
      : await this.elevenLabsService.listVoices();

    if (!cached) {
      await this.redis.set(
        VOICES_CACHE_KEY,
        JSON.stringify(voices),
        'EX',
        VOICES_CACHE_TTL,
      );
    }

    if (accent) {
      const normalised = accent.toLowerCase();
      return voices.filter(
        (v: any) => v.labels?.accent?.toLowerCase() === normalised,
      );
    }

    return voices;
  }

  // Resolve the set of voiceIds that ElevenLabs reports as available to this
  // account. Used to validate client-supplied overrides before they mutate
  // session state — rejects typos or stolen-from-another-account ids early,
  // instead of letting them silently break TTS at playback time.
  private async getValidVoiceIds(): Promise<Set<string>> {
    const cached = await this.redis.get(VOICES_CACHE_KEY);
    let voices: Array<{ voiceId: string }>;
    if (cached) {
      voices = JSON.parse(cached);
    } else {
      voices = (await this.elevenLabsService.listVoices()) as Array<{
        voiceId: string;
      }>;
      await this.redis.set(
        VOICES_CACHE_KEY,
        JSON.stringify(voices),
        'EX',
        VOICES_CACHE_TTL,
      );
    }
    return new Set<string>((voices ?? []).map((v) => v.voiceId));
  }

  private assertVoiceIdsKnown(
    overrides: Record<string, string>,
    validVoiceIds: Set<string>,
  ): void {
    const unknown: string[] = [];
    for (const [characterId, voiceId] of Object.entries(overrides)) {
      if (!validVoiceIds.has(voiceId)) {
        unknown.push(`${characterId}→${voiceId}`);
      }
    }
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'UNKNOWN_VOICE_ID',
        message: `Unknown voiceId(s) in override: ${unknown.join(', ')}`,
      });
    }
  }

  // POST /api/hazel/session/:rehearsalId/voices
  @Post('session/:rehearsalId/voices')
  @ApiOperation({
    summary: 'Update voice overrides for a session',
    description:
      "Merges the provided character→voiceId overrides into the session's voice map and triggers re-generation of affected audio lines. Allowed in any session status except `active` — i.e., `preparing`, `ready`, and `paused` are all valid. Rejected during `active` because audio is being streamed to the client. The merged map is also persisted to `rehearsal.metaData.voiceMap` so `GET /api/rehearsals/:id/settings` can pre-fill the voice dropdowns on subsequent modal opens.",
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'characterId (UUID) to ElevenLabs voice ID mapping',
    schema: {
      type: 'object',
      required: ['overrides'],
      properties: {
        overrides: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of characterId (UUID) → ElevenLabs voiceId',
          example: {
            '423e4567-e89b-12d3-a456-426614174003': 'TxGEqnHWrfWFTfGW9XjX',
            '523e4567-e89b-12d3-a456-426614174004': 'yoZ06aMxZJJ28mfd3POQ',
          },
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Updated voice map',
    schema: {
      type: 'object',
      properties: {
        voiceMap: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: {
            '423e4567-e89b-12d3-a456-426614174003': 'TxGEqnHWrfWFTfGW9XjX',
            '523e4567-e89b-12d3-a456-426614174004': 'yoZ06aMxZJJ28mfd3POQ',
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Not your session or session is in a status that blocks voice changes (active or ended)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example:
            'Voice overrides can only be changed while the session is preparing, ready, or paused',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Session not found in Redis (session may have expired)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Session not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async updateVoices(
    @Param('rehearsalId') rehearsalId: string,
    @Body() body: { overrides: Record<string, string> },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    const state = await this.sessionService.getSession(rehearsalId);

    if (state.userId !== userId) {
      throw new BadRequestException('Not your session');
    }

    if (
      state.status !== 'preparing' &&
      state.status !== 'ready' &&
      state.status !== 'paused'
    ) {
      throw new BadRequestException(
        'Voice overrides can only be changed while the session is preparing, ready, or paused',
      );
    }

    const overrides = body.overrides ?? {};
    if (Object.keys(overrides).length > 0) {
      const validVoiceIds = await this.getValidVoiceIds();
      this.assertVoiceIdsKnown(overrides, validVoiceIds);
    }

    // merge overrides into voiceMap — this is the source of truth for playback.
    // Turn sequence carries no voiceId, so no sequence rewrite is needed.
    const newVoiceMap = { ...state.voiceMap, ...overrides };
    await this.sessionService.updateSession(rehearsalId, {
      voiceMap: newVoiceMap,
    });

    // Persist to rehearsal.metaData so the settings endpoint can pre-fill the
    // voice dropdown on subsequent modal opens — Redis session TTL is 4h,
    // metaData survives across sessions.
    const rehearsalForPersist =
      await this.rehersalRepository.findById(rehearsalId);
    if (rehearsalForPersist) {
      await this.rehersalRepository.updateById(rehearsalId, {
        metaData: {
          ...(rehearsalForPersist.metaData ?? {}),
          voiceMap: newVoiceMap,
        },
      });
    }

    // Re-gen audio for turns whose character had its voice overridden.
    // We await so the HTTP call only resolves once the cache is consistent
    // with the new voiceMap — removes the race where a session starts before
    // re-gen completes and serves stale audio from the old voice.
    const turns = await this.sequenceBuilder.getSequence(rehearsalId);
    const affectedTurns = turns.filter(
      (t) =>
        t.type === 'hazel' &&
        t.characterId !== undefined &&
        overrides[t.characterId] !== undefined,
    );

    try {
      await this.audioPregen.pregenerateSession(
        rehearsalId,
        affectedTurns,
        newVoiceMap,
      );
    } catch (e: any) {
      this.logger.error(`Voice override re-gen failed: ${e.message}`);
      // Don't roll back voiceMap — playback-time fallback will still resolve
      // the new voice via live TTS (graceful degradation).
      throw new BadRequestException({
        code: 'VOICE_REGEN_FAILED',
        message:
          'Voice override applied but audio pre-generation failed — playback will fall back to live TTS',
      });
    }

    return {
      voiceMap: newVoiceMap,
      regenerated: affectedTurns.length,
    };
  }

  // POST /api/hazel/session/prepare
  @Post('session/prepare')
  @ApiOperation({
    summary: 'Prepare a Hazel AI rehearsal session',
    description:
      'Validates rehearsal ownership, builds the turn sequence for the scene, runs a quota check, and starts background ElevenLabs audio pre-generation. Returns immediately — poll `GET /session/:rehearsalId/prepare/status` until `status: "ready"` before starting the WebSocket session. The final voiceMap (keyword-based defaults merged with any `voiceOverrides`) is persisted to `rehearsal.metaData.voiceMap`, so `GET /api/rehearsals/:id/settings` will reflect the current voice assignments for the settings modal.',
  })
  @ApiBody({
    description: 'Session preparation parameters',
    schema: {
      type: 'object',
      required: ['rehearsalId', 'sceneId', 'characterId'],
      properties: {
        rehearsalId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        sceneId: {
          type: 'string',
          format: 'uuid',
          example: '323e4567-e89b-12d3-a456-426614174002',
        },
        characterId: {
          type: 'string',
          format: 'uuid',
          example: '423e4567-e89b-12d3-a456-426614174003',
        },
        voiceOverrides: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional characterId (UUID) → ElevenLabs voiceId overrides',
          example: {
            '423e4567-e89b-12d3-a456-426614174003': 'TxGEqnHWrfWFTfGW9XjX',
          },
        },
      },
    },
  })
  @ApiOkResponse({
    description:
      'Session prepared — audio pre-generation started in background',
    schema: {
      type: 'object',
      properties: {
        rehearsalId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        totalLines: {
          type: 'number',
          example: 42,
          description: 'Total turns in the scene sequence',
        },
        hazelLineCount: {
          type: 'number',
          example: 28,
          description: 'Number of Hazel (AI) lines that will be pre-generated',
        },
        estimatedPrepSeconds: {
          type: 'number',
          example: 14,
          description: 'Rough estimate of pre-generation time in seconds',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Missing required fields, session conflict, or quota exceeded',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'rehearsalId, sceneId, and characterId are required',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description:
      'Rehearsal not found or actor is not a character in this scene',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Rehearsal not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async prepareSession(
    @Req() req: Request,
    @Body()
    body: {
      rehearsalId: string;
      sceneId: string;
      characterId: string;
      voiceOverrides?: Record<string, string>;
    },
  ) {
    const userId = (req as any).user?.id;
    const { rehearsalId, sceneId, characterId, voiceOverrides = {} } = body;

    if (!rehearsalId || !sceneId || !characterId) {
      throw new BadRequestException(
        'rehearsalId, sceneId, and characterId are required',
      );
    }

    if (Object.keys(voiceOverrides).length > 0) {
      const validVoiceIds = await this.getValidVoiceIds();
      this.assertVoiceIdsKnown(voiceOverrides, validVoiceIds);
    }

    // acquire per-user concurrency lock (4.1.7)
    let lockResult = await this.sessionService.acquireUserLock(userId);
    if (!lockResult.acquired) {
      const recovered =
        await this.sessionService.recoverStaleSessionsForUser(userId);
      if (!recovered) {
        throw new BadRequestException({
          code: 'SESSION_CONFLICT',
          message: 'You already have an active rehearsal session',
        });
      }

      lockResult = await this.sessionService.acquireUserLock(userId);
      if (!lockResult.acquired) {
        throw new BadRequestException({
          code: 'SESSION_CONFLICT',
          message: 'You already have an active rehearsal session',
        });
      }
    }

    let sessionCreated = false;

    try {
      // validate rehearsal ownership
      const rehearsal = await this.rehersalRepository.findById(rehearsalId);
      if (!rehearsal || rehearsal.userId !== userId) {
        throw new NotFoundException('Rehearsal not found');
      }

      if (rehearsal.mode !== RehearsalMode.AI) {
        throw new BadRequestException(
          'Hazel preparation is only supported for AI rehearsals',
        );
      }

      if (!rehearsal.sceneId || !rehearsal.scriptId) {
        throw new BadRequestException(
          'This rehearsal is missing the content required for Hazel preparation',
        );
      }

      if (rehearsal.sceneId !== sceneId) {
        throw new BadRequestException(
          'The requested scene does not match the configured rehearsal scene',
        );
      }

      if (!rehearsal.characterId) {
        throw new BadRequestException(
          'Select a rehearsal character before preparing Hazel',
        );
      }

      if (rehearsal.characterId !== characterId) {
        throw new BadRequestException(
          'The requested character does not match the configured rehearsal setup',
        );
      }

      // create session in Redis as 'preparing'
      await this.sessionService.createSession(
        userId,
        rehearsalId,
        sceneId,
        characterId,
        {},
        lockResult.lockToken,
      );
      sessionCreated = true;
      await this.sessionService.markPreparing(rehearsalId, characterId);

      // load scene elements
      const elements = await this.sceneLoader.loadScene(sceneId, characterId);

      // build voice map
      const scriptCharacters = await this.characterRepository.findByScriptId(
        rehearsal.scriptId,
      );
      const defaultVoiceMap = await this.voiceMapper.buildDefaultVoiceMap(
        scriptCharacters,
        characterId,
      );
      const presetVoiceMap =
        (rehearsal.metaData?.voiceMap as Record<string, string>) ?? {};
      const voiceMap = {
        ...defaultVoiceMap,
        ...presetVoiceMap,
        ...voiceOverrides,
      };

      this.logger.debug(
        `Voice map for ${rehearsalId}: ${JSON.stringify(Object.keys(voiceMap))}`,
      );

      await this.sessionService.updateSession(rehearsalId, { voiceMap });

      // Persist to rehearsal.metaData so the settings endpoint can pre-fill the
      // voice dropdown. First prepare seeds the keyword-based defaults; any
      // user override merged in above is persisted too.
      await this.rehersalRepository.updateById(rehearsalId, {
        metaData: { ...(rehearsal.metaData ?? {}), voiceMap },
      });

      // build and store turn sequence
      const turns = await this.sequenceBuilder.build(
        rehearsalId,
        elements,
        characterId,
      );
      const hazelLineCount = turns.filter((t) => t.type === 'hazel').length;

      await this.sessionService.updateSession(rehearsalId, {
        totalLines: turns.length,
      });

      // quota check before committing
      const estimatedMinutes = Math.ceil(turns.length * 0.25); // rough estimate
      await this.usageMeter.checkQuota(userId, turns, estimatedMinutes);

      // Fast start: generate ONLY the first hazel line, then mark ready so the
      // client can connect and begin. The remaining lines are generated in the
      // background; cache misses fall through to live streaming at playback.
      try {
        await this.audioPregen.pregenerateFirstHazelLine(
          rehearsalId,
          turns,
          voiceMap,
        );
        await this.sessionService.setStatus(rehearsalId, 'ready');
        await this.sessionService.markReady(rehearsalId);
      } catch (error) {
        this.logger.error(
          `Hazel first-line generation failed for ${rehearsalId}: ${(error as Error).message}`,
        );
        await this.sessionService.forceResetSession(
          rehearsalId,
          userId,
          RehearsalStatus.FAILED,
        );
        throw error;
      }

      // Background-generate the remaining lines; failures are non-fatal
      // (live stream covers cache misses).
      void this.audioPregen
        .pregenerateSession(rehearsalId, turns, voiceMap)
        .catch((error: Error) =>
          this.logger.error(
            `Hazel background pre-generation failed for ${rehearsalId}: ${error.message}`,
          ),
        );

      return {
        rehearsalId,
        totalLines: turns.length,
        hazelLineCount,
        estimatedPrepSeconds: Math.ceil(hazelLineCount * 0.5),
      };
    } catch (err) {
      if (sessionCreated) {
        await this.sessionService.forceResetSession(
          rehearsalId,
          userId,
          RehearsalStatus.FAILED,
        );
      } else {
        await this.sessionService.releaseUserLock(userId, lockResult.lockToken);
      }
      throw err;
    }
  }

  // GET /api/hazel/session/:rehearsalId/prepare/status
  @Get('session/:rehearsalId/prepare/status')
  @ApiOperation({
    summary: 'Poll session readiness + audio pre-generation progress',
    description:
      'Returns the session readiness `status` plus background pre-generation progress. With fast start, `POST /session/prepare` generates only the FIRST Hazel line and returns `status: "ready"` almost immediately — you may connect to the `/hazel` WebSocket namespace and emit `session.start` as soon as `status` is `"ready"`. The remaining lines pre-generate in the background (cache misses fall through to real-time streaming at playback), so the `total`/`completed`/`percentComplete` fields keep climbing AFTER the session is already startable — treat them as an optional progress indicator, not a gate.',
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Current pre-generation progress',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['preparing', 'ready', 'failed'],
          example: 'preparing',
        },
        total: {
          type: 'number',
          example: 28,
          description: 'Total Hazel lines to pre-generate',
        },
        completed: {
          type: 'number',
          example: 14,
          description: 'Lines successfully pre-generated',
        },
        failed: {
          type: 'number',
          example: 0,
          description:
            'Lines that failed pre-generation (will use real-time fallback)',
        },
        percentComplete: {
          type: 'number',
          example: 50,
          description: 'Percentage of pre-generation completed',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Session not found in Redis (may have expired)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Session not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getPrepareStatus(@Param('rehearsalId') rehearsalId: string) {
    const progress = await this.audioPregen.getProgress(rehearsalId);
    const percentComplete =
      progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;

    // Readiness is driven by the SESSION status, not full pre-generation.
    // prepareSession marks the session `ready` after only the first Hazel line
    // is generated (fast start); background pre-gen of the rest continues after.
    // The progress fields are advisory. Fall back to pregen-derived status only
    // when the session is gone (expired or failed → forceReset clears it).
    let status: string = progress.status === 'done' ? 'ready' : progress.status;
    const session = await this.sessionService
      .getSession(rehearsalId)
      .catch(() => null);
    if (session?.status === 'ready' || session?.status === 'active') {
      status = 'ready';
    } else if (session?.status === 'preparing') {
      status = 'preparing';
    }

    return {
      status,
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      percentComplete,
    };
  }

  // POST /api/hazel/smart-turn
  // Proxies a turn-detection check to the internal smart-turn service
  // (script_parser). The frontend sends the actor's recent audio; we return
  // the turn-completion probability. The model runs server-side so the
  // featurization exactly matches the pipecat reference. Auth is the global
  // JwtAuthGuard; the internal service is never exposed publicly.
  @Post('smart-turn')
  @ApiOperation({
    summary: 'Turn-detection (smart-turn) check',
    description:
      'Given the actor’s recent utterance audio, returns the probability that the actor has finished their turn. Body: `{ audio: <base64 Int16 PCM, 16kHz mono, last ≤8s> }`. Returns `{ probability, complete }`. Call this at each detected pause; emit `turn.end` on the `/hazel` socket when `complete` is true.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: {
          type: 'string',
          description: 'Base64-encoded little-endian Int16 PCM, 16kHz mono, last ≤8s',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Turn-completion probability',
    schema: {
      type: 'object',
      properties: {
        probability: { type: 'number', example: 0.93 },
        complete: { type: 'boolean', example: true },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Missing or invalid audio payload' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing authentication token' })
  async smartTurnCheck(
    @Body() body: { audio?: string },
  ): Promise<{ probability: number; complete: boolean }> {
    if (!body?.audio) {
      throw new BadRequestException('audio (base64 Int16 PCM) is required');
    }

    const pcm = Buffer.from(body.audio, 'base64');
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new BadRequestException('audio must be non-empty Int16 PCM');
    }

    const baseUrl =
      process.env.SMART_TURN_URL ?? 'http://localhost:3005';

    // Abort if the internal service hangs — turn detection is latency-critical.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await fetch(`${baseUrl}/smart-turn/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        this.logger.warn(
          `smart-turn upstream ${resp.status}: ${text.slice(0, 200)}`,
        );
        throw new ServiceUnavailableException('smart-turn check failed');
      }
      return (await resp.json()) as { probability: number; complete: boolean };
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`smart-turn proxy error: ${err?.message ?? err}`);
      throw new ServiceUnavailableException('smart-turn service unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  @Delete('session/:rehearsalId')
  @ApiOperation({
    summary: 'Force-clear a Hazel session',
    description:
      'Immediately clears Hazel Redis session state for the given rehearsal, releases the per-user lock, flushes buffered events, and revokes the scoped Deepgram key if one was issued. Intended as a recovery path when a client session becomes stuck.',
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Hazel session cleared',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Hazel session cleared successfully',
        },
        data: {
          type: 'object',
          properties: {
            rehearsalId: {
              type: 'string',
              format: 'uuid',
              example: '123e4567-e89b-12d3-a456-426614174000',
            },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Hazel session or rehearsal not found for this user',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async resetSession(
    @Req() req: Request,
    @Param('rehearsalId') rehearsalId: string,
  ) {
    const userId = (req as any).user?.id;
    const state = await this.sessionService
      .getSession(rehearsalId)
      .catch(() => null);

    if (state && state.userId !== userId) {
      throw new BadRequestException('Not your session');
    }

    if (!state) {
      const rehearsal = await this.rehersalRepository.findById(rehearsalId);
      if (!rehearsal || rehearsal.userId !== userId) {
        throw new NotFoundException('Hazel session not found');
      }
    }

    this.sequencer.cleanup(rehearsalId);
    await this.eventLogger.flushSession(rehearsalId);

    if (state?.deepgramKeyId) {
      await this.deepgramService.revokeKey(state.deepgramKeyId);
    }

    await this.sessionService.forceResetSession(
      rehearsalId,
      userId,
      RehearsalStatus.CANCELLED,
    );

    return {
      success: true,
      message: 'Hazel session cleared successfully',
      data: { rehearsalId },
    };
  }

  // GET /api/hazel/deepgram-token
  @Get('deepgram-token')
  @ApiOperation({
    summary: 'Issue a scoped Deepgram session key',
    description:
      'Creates a short-lived Deepgram API key with `usage:write` scope only. The browser uses this key to open a WebSocket directly to Deepgram for speech-to-text. The master API key is never exposed. Key is valid for 2 hours and is revoked when the session ends. Session must be in `ready` or `active` status.',
  })
  @ApiQuery({
    name: 'rehearsalId',
    description: 'Rehearsal UUID (format: uuid)',
    required: true,
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Scoped Deepgram key with recommended client configuration',
    schema: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          example: 'dg_abc123...',
          description:
            'Scoped Deepgram API key for browser use only — do not log or store',
        },
        expiresIn: {
          type: 'number',
          example: 7200,
          description: 'Key lifetime in seconds',
        },
        config: {
          type: 'object',
          description: 'Recommended Deepgram LiveTranscription options',
          properties: {
            model: { type: 'string', example: 'nova-2' },
            language: { type: 'string', example: 'en' },
            punctuate: { type: 'boolean', example: true },
            smart_format: { type: 'boolean', example: true },
            interim_results: { type: 'boolean', example: true },
            endpointing: { type: 'number', example: 1000 },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing rehearsalId, not your session, or session is not ready/active',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'Session must be ready or active to obtain a token',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Session not found in Redis',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Session not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getDeepgramToken(
    @Req() req: Request,
    @Query('rehearsalId') rehearsalId: string,
  ) {
    if (!rehearsalId) {
      throw new BadRequestException('rehearsalId query parameter is required');
    }

    const userId = (req as any).user?.id;
    const state = await this.sessionService.getSession(rehearsalId);

    if (state.userId !== userId) {
      throw new BadRequestException('Not your session');
    }

    if (state.status !== 'ready' && state.status !== 'active') {
      throw new BadRequestException(
        'Session must be ready or active to obtain a token',
      );
    }

    const { keyId, apiKey } = await this.deepgramService.createSessionKey(
      rehearsalId,
      7200, // 2-hour key
    );

    await this.sessionService.updateSession(rehearsalId, {
      deepgramKeyId: keyId,
    });

    // build keyword hints from the scene's script lines to bias Deepgram
    // toward the script's vocabulary (e.g., character names, slang, unique words)
    let keywords: string[] = [];
    try {
      const sequence = await this.sequenceBuilder.getSequence(rehearsalId);
      const scriptLines = sequence
        .filter((t) => t.type === 'actor' || t.type === 'hazel')
        .map((t) => t.text);
      keywords = this.deepgramService.buildKeywordHints(scriptLines);
    } catch (err: any) {
      this.logger.warn(
        `Failed to build keyword hints for ${rehearsalId}: ${err.message}`,
      );
    }

    return {
      apiKey,
      expiresIn: 7200,
      config: this.deepgramService.getRecommendedConfig(keywords),
    };
  }
}
