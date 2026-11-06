export interface SttEvaluationResult {
  matchRatio: number;
  decision: 'advance' | 'partial' | 'none';
}

export abstract class SpeechToTextService {
  abstract evaluateTranscript(
    transcript: string,
    expectedLine: string,
    isInterim: boolean,
  ): SttEvaluationResult;
}
