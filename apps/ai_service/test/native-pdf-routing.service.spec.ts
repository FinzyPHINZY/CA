import { NativePdfRoutingService } from '../src/modules/ai-orchestrator/services/native-pdf-routing.service';
import { NativePdfCapabilityResult } from '../src/modules/ai-orchestrator/services/native-pdf-capability-detector.service';

function makeCapability(
  strength: NativePdfCapabilityResult['nativeTextLayerStrength'],
): NativePdfCapabilityResult {
  return {
    nativeTextLayerDetected: strength !== 'absent',
    nativeTextLayerStrength: strength,
    recommendedPath: strength === 'absent' ? 'ocr_fallback' : 'native_text',
    reasons: [],
    evaluatedAt: new Date().toISOString(),
    signals: {
      sampledPages: 2,
      pageCount: 2,
      textCharCount: 1000,
      nonEmptyLineCount: 50,
      avgCharsPerPage: 500,
      screenplaySignalScore: strength === 'strong' ? 0.7 : 0.25,
      noiseSignalScore: 0.1,
      layoutCoherenceScore: strength === 'strong' ? 0.6 : 0.3,
      sceneHeadingMatches: 2,
      characterCueMatches: 4,
      dialogueLikeLines: 8,
      repeatedNoiseLineCount: 0,
      watermarkKeywordHits: 0,
    },
  };
}

describe('native pdf routing service', () => {
  let service: NativePdfRoutingService;

  beforeEach(() => {
    service = new NativePdfRoutingService();
  });

  it('routes strong native capability to native text first when enabled', () => {
    const decision = service.decide({
      fileName: 'watermark-side.pdf',
      capability: makeCapability('strong'),
      nativeRoutingEnabled: true,
      nativeRoutingRollout: 100,
      externalExtractorEligible: true,
    });

    expect(decision.initialExtractionPath).toBe('native_text_first');
    expect(decision.nativeFirstApplied).toBe(true);
    expect(decision.rolloutMatched).toBe(true);
  });

  it('routes weak native capability to native text first when enabled', () => {
    const decision = service.decide({
      fileName: 'mixed-side.pdf',
      capability: makeCapability('weak'),
      nativeRoutingEnabled: true,
      nativeRoutingRollout: 100,
      externalExtractorEligible: true,
    });

    expect(decision.initialExtractionPath).toBe('native_text_first');
    expect(decision.nativeFirstApplied).toBe(true);
  });

  it('keeps external extractor for absent native capability', () => {
    const decision = service.decide({
      fileName: 'flattened.pdf',
      capability: makeCapability('absent'),
      nativeRoutingEnabled: true,
      nativeRoutingRollout: 100,
      externalExtractorEligible: true,
    });

    expect(decision.initialExtractionPath).toBe('external_extractor');
    expect(decision.nativeFirstApplied).toBe(false);
  });

  it('falls back to legacy pdf when native routing is disabled and no external extractor is available', () => {
    const decision = service.decide({
      fileName: 'clean.pdf',
      capability: makeCapability('strong'),
      nativeRoutingEnabled: false,
      nativeRoutingRollout: 100,
      externalExtractorEligible: false,
    });

    expect(decision.initialExtractionPath).toBe('legacy_pdf');
    expect(decision.nativeFirstApplied).toBe(false);
  });
});
