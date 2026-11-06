import * as pdfParse from 'pdf-parse';
import { NativePdfCapabilityDetectorService } from '../src/modules/ai-orchestrator/services/native-pdf-capability-detector.service';

jest.mock('pdf-parse', () => jest.fn());

const mockedPdfParse = pdfParse as jest.MockedFunction<typeof pdfParse>;

describe('native pdf capability detector service', () => {
  let service: NativePdfCapabilityDetectorService;

  beforeEach(() => {
    service = new NativePdfCapabilityDetectorService();
    mockedPdfParse.mockReset();
  });

  it('classifies strong screenplay-like native text as strong capability', async () => {
    mockedPdfParse.mockResolvedValue({
      text: `INT. KITCHEN - DAY

SARAH
I told you not to touch that.

MARCUS
I only moved it because it was burning.

EXT. DRIVEWAY - NIGHT

SARAH
Then tell me the truth.`,
      numpages: 2,
    } as any);

    const result = await service.detect(Buffer.from('pdf'), 'clean.pdf');

    expect(result.nativeTextLayerDetected).toBe(true);
    expect(result.nativeTextLayerStrength).toBe('strong');
    expect(result.recommendedPath).toBe('native_text');
    expect(result.signals.sceneHeadingMatches).toBeGreaterThanOrEqual(2);
    expect(result.signals.characterCueMatches).toBeGreaterThanOrEqual(2);
  });

  it('classifies readable but weak screenplay signals as weak capability', async () => {
    mockedPdfParse.mockResolvedValue({
      text: `Episode 207
Page turn draft

Grace loses control in the middle of the club while Carmen watches from the curb.
The room is loud and chaotic and everyone is staring.
Tina is nearby and the music keeps going while the crowd reacts.`,
      numpages: 1,
    } as any);

    const result = await service.detect(Buffer.from('pdf'), 'mixed.pdf');

    expect(result.nativeTextLayerDetected).toBe(true);
    expect(result.nativeTextLayerStrength).toBe('weak');
    expect(result.recommendedPath).toBe('native_text');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('mixed')]),
    );
  });

  it('classifies empty or failed native inspection as absent capability', async () => {
    mockedPdfParse.mockRejectedValue(new Error('parse failed'));

    const result = await service.detect(Buffer.from('pdf'), 'broken.pdf');

    expect(result.nativeTextLayerDetected).toBe(false);
    expect(result.nativeTextLayerStrength).toBe('absent');
    expect(result.recommendedPath).toBe('ocr_fallback');
    expect(result.reasons[0]).toContain('parse failed');
  });
});
