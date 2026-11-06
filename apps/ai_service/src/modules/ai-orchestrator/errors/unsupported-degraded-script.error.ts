import { BadRequestException } from '@nestjs/common';
import type { DegradedInputClassification } from '../services/degraded-input-classifier.service';

export interface UnsupportedDegradedScriptErrorOptions {
  message: string;
  failureStage?: string;
  structuralPath: string;
  semanticPath: string;
  extractionSource: string | null;
  degradedInputClassification: DegradedInputClassification;
}

export class UnsupportedDegradedScriptError extends BadRequestException {
  readonly failureCode = 'VISUALLY_DEGRADED_INPUT';
  readonly failureStage: string;
  readonly failureMessage: string;
  readonly structuralPath: string;
  readonly semanticPath: string;
  readonly extractionSource: string | null;
  readonly degradedInputClassification: DegradedInputClassification;

  constructor(options: UnsupportedDegradedScriptErrorOptions) {
    super(options.message);
    this.failureMessage = options.message;
    this.failureStage = options.failureStage || 'degraded_input_screening';
    this.structuralPath = options.structuralPath;
    this.semanticPath = options.semanticPath;
    this.extractionSource = options.extractionSource;
    this.degradedInputClassification = options.degradedInputClassification;
  }
}
