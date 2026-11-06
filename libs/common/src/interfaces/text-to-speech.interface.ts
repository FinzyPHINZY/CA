export interface VoiceMetadata {
  voiceId: string;
  name: string;
  description: string;
  previewAudioUrl: string;
  labels: {
    gender?: string;
    age?: string;
    accent?: string;
    useCase?: string;
  };
}

export abstract class TextToSpeechService {
  abstract generateAudio(
    text: string,
    voiceId: string,
    modelId: string,
  ): Promise<Buffer>;

  /**
   * Stream audio chunks as they are generated upstream. First chunk
   * arrives ~250ms after the request — vs ~1500ms for the buffered
   * `generateAudio`. Implementations that cannot stream may fall back
   * to yielding the full buffer in a single chunk.
   */
  abstract generateAudioStream(
    text: string,
    voiceId: string,
    modelId: string,
  ): AsyncIterable<Buffer>;

  abstract listVoices(): Promise<VoiceMetadata[]>;
}
