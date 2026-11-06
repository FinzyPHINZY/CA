import { NativePdfWatermarkSuppressionService } from '../src/modules/ai-orchestrator/services/extraction/native-pdf-watermark-suppression.service';
import { ExtractedBlock } from '../src/modules/ai-orchestrator/services/extraction/document-extraction.types';

describe('native pdf watermark suppression service', () => {
  let service: NativePdfWatermarkSuppressionService;

  beforeEach(() => {
    service = new NativePdfWatermarkSuppressionService();
  });

  it('removes repeated middle watermark blocks while preserving screenplay content', () => {
    const blocks: ExtractedBlock[] = [
      {
        text: 'CONFIDENTIAL',
        page: 1,
        boundingBox: [250, 300, 350, 300, 350, 330, 250, 330],
        attributes: { fontSize: 28, rotationDegrees: 18 },
      },
      {
        text: 'CONFIDENTIAL',
        page: 2,
        boundingBox: [250, 300, 350, 300, 350, 330, 250, 330],
        attributes: { fontSize: 28, rotationDegrees: 18 },
      },
      {
        text: 'INT. KITCHEN - DAY',
        page: 1,
        boundingBox: [72, 100, 200, 100, 200, 112, 72, 112],
        attributes: { fontSize: 12, rotationDegrees: 0 },
      },
      {
        text: 'SARAH',
        page: 1,
        boundingBox: [240, 180, 280, 180, 280, 192, 240, 192],
        attributes: { fontSize: 12, rotationDegrees: 0 },
      },
    ];

    const result = service.suppress(blocks);

    expect(result.blocks.map((block) => block.text)).toEqual(
      expect.arrayContaining(['INT. KITCHEN - DAY', 'SARAH']),
    );
    expect(result.blocks.map((block) => block.text)).not.toContain(
      'CONFIDENTIAL',
    );
    expect(result.watermarkDetected).toBe(true);
    expect(result.removedWatermarkCount).toBe(2);
  });

  it('removes repeated header/footer tracking text conservatively', () => {
    const blocks: ExtractedBlock[] = [
      {
        text: 'EPISODE 207',
        page: 1,
        boundingBox: [120, 10, 220, 10, 220, 20, 120, 20],
      },
      {
        text: 'EPISODE 207',
        page: 2,
        boundingBox: [120, 10, 220, 10, 220, 20, 120, 20],
      },
      {
        text: 'CARMEN',
        page: 2,
        boundingBox: [240, 200, 300, 200, 300, 212, 240, 212],
      },
    ];

    const result = service.suppress(blocks);

    expect(result.blocks.map((block) => block.text)).toEqual(['CARMEN']);
    expect(result.removedHeaderFooterCount).toBe(2);
  });
});
