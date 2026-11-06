import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  NativePdfCapabilityResult,
  NativePdfCapabilityStrength,
} from './native-pdf-capability-detector.service';

export type NativePdfInitialExtractionPath =
  | 'native_text_first'
  | 'external_extractor'
  | 'legacy_pdf';

export interface NativePdfRoutingDecision {
  initialExtractionPath: NativePdfInitialExtractionPath;
  nativeFirstApplied: boolean;
  rolloutMatched: boolean;
  reasons: string[];
}

export interface NativePdfRoutingInput {
  fileName: string | null;
  capability: NativePdfCapabilityResult | null;
  nativeRoutingEnabled: boolean;
  nativeRoutingRollout: number;
  externalExtractorEligible: boolean;
}

@Injectable()
export class NativePdfRoutingService {
  decide(input: NativePdfRoutingInput): NativePdfRoutingDecision {
    const reasons: string[] = [];
    const rolloutMatched = this.matchesRollout(
      input.fileName,
      input.nativeRoutingEnabled,
      input.nativeRoutingRollout,
    );

    if (!input.capability) {
      reasons.push(
        'Native PDF capability result was unavailable, so routing fell back to the existing extractor decision.',
      );
      return this.defaultDecision(input.externalExtractorEligible, reasons);
    }

    if (!input.nativeRoutingEnabled) {
      reasons.push(
        'Native PDF first routing is disabled, so the existing extractor decision remains active.',
      );
      return this.defaultDecision(input.externalExtractorEligible, reasons);
    }

    if (!rolloutMatched) {
      reasons.push(
        `Native PDF first routing rollout skipped this file (rollout ${input.nativeRoutingRollout}%).`,
      );
      return this.defaultDecision(input.externalExtractorEligible, reasons, {
        nativeFirstApplied: false,
        rolloutMatched: false,
      });
    }

    const strength = input.capability.nativeTextLayerStrength;
    if (strength === 'strong' || strength === 'weak') {
      reasons.push(
        `Native text layer classified as ${strength}; native text extraction should be attempted first.`,
      );
      return {
        initialExtractionPath: 'native_text_first',
        nativeFirstApplied: true,
        rolloutMatched: true,
        reasons,
      };
    }

    reasons.push(
      `Native text layer classified as ${strength}; OCR/vendor fallback remains the preferred initial route.`,
    );
    return this.defaultDecision(input.externalExtractorEligible, reasons, {
      nativeFirstApplied: false,
      rolloutMatched: true,
    });
  }

  private defaultDecision(
    externalExtractorEligible: boolean,
    reasons: string[],
    overrides?: {
      nativeFirstApplied?: boolean;
      rolloutMatched?: boolean;
    },
  ): NativePdfRoutingDecision {
    return {
      initialExtractionPath: externalExtractorEligible
        ? 'external_extractor'
        : 'legacy_pdf',
      nativeFirstApplied: overrides?.nativeFirstApplied ?? false,
      rolloutMatched: overrides?.rolloutMatched ?? false,
      reasons,
    };
  }

  private matchesRollout(
    fileName: string | null,
    enabled: boolean,
    rollout: number,
  ): boolean {
    if (!enabled) return false;
    if (rollout >= 100) return true;
    if (rollout <= 0) return false;

    const key = (fileName || '').toLowerCase() || crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(key).digest();
    const bucket = hash[0] % 100;
    return bucket < rollout;
  }
}
