/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

// implements TextToSpeechService via ElevenLabs REST API.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Readable } from 'node:stream';
import { TextToSpeechService, VoiceMetadata } from '@app/common';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

@Injectable()
export class ElevenLabsService extends TextToSpeechService {
  private readonly logger = new Logger(ElevenLabsService.name);
  private readonly apiKey: string;
  readonly defaultModelId: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.apiKey = this.configService.get<string>(
      'ELEVENLABS_API_KEY',
      'placeholder_elevenlabs_key',
    );
    this.defaultModelId = this.configService.get<string>(
      'ELEVENLABS_DEFAULT_MODEL',
      'eleven_turbo_v2_5',
    );
  }

  // generate audio for a line. returns mp3 buffer.
  // Used by the pre-gen pipeline (which writes the full mp3 into Redis cache).
  async generateAudio(
    text: string,
    voiceId: string,
    modelId: string,
  ): Promise<Buffer> {
    const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`;
    const response = await axios.post(
      url,
      {
        model_id: modelId || this.defaultModelId,
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 30_000,
      },
    );
    this.logger.debug(`ElevenLabs TTS: ${text.slice(0, 40)}… (${voiceId})`);
    return Buffer.from(response.data as ArrayBuffer);
  }

  /**
   * Stream mp3 audio for a line via ElevenLabs' `/stream` endpoint.
   * First chunk arrives in ~250ms vs ~1500ms for the buffered call —
   * used on the live playback path so the actor hears Hazel start
   * speaking as soon as the first bytes are generated.
   *
   * Errors thrown synchronously (network failure, 4xx/5xx, timeout)
   * are propagated to the caller; mid-stream errors emit on the
   * underlying Readable. The caller MUST handle the latter — the
   * streaming generator below surfaces them as iteration-time throws.
   */
  async *generateAudioStream(
    text: string,
    voiceId: string,
    modelId: string,
  ): AsyncIterable<Buffer> {
    const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`;
    const response = await axios.post(
      url,
      {
        model_id: modelId || this.defaultModelId,
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'stream',
        timeout: 30_000,
      },
    );
    this.logger.debug(
      `ElevenLabs TTS stream: ${text.slice(0, 40)}… (${voiceId})`,
    );
    const stream = response.data as Readable;
    try {
      for await (const chunk of stream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      }
    } finally {
      stream.destroy();
    }
  }

  // list available voices. Mapped to VoiceMetadata[].
  async listVoices(): Promise<VoiceMetadata[]> {
    const response = await axios.get(`${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': this.apiKey },
      timeout: 10_000,
    });

    const voices = (response.data as any)?.voices ?? [];
    return voices.map((v: any) => ({
      voiceId: v.voice_id,
      name: v.name,
      description: v.description ?? '',
      previewAudioUrl: v.preview_url ?? '',
      labels: {
        gender: v.labels?.gender,
        age: v.labels?.age,
        accent: v.labels?.accent,
        useCase: v.labels?.use_case,
      },
    }));
  }
}
