import { NativePdfExtractService } from '../src/modules/ai-orchestrator/services/extraction/native-pdf-extract.service';

describe('native pdf extract service', () => {
  let service: NativePdfExtractService;

  beforeEach(() => {
    service = new NativePdfExtractService();
  });

  it('maps positioned text items into extracted blocks', async () => {
    const fakePdfJs = {
      getDocument: jest.fn(() => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: jest.fn(async () => ({
            getViewport: jest.fn(() => ({ height: 800 })),
            getTextContent: jest.fn(async () => ({
              items: [
                {
                  str: 'INT. KITCHEN - DAY',
                  transform: [12, 0, 0, 12, 72, 700],
                  width: 120,
                  height: 12,
                  fontName: 'Courier',
                },
                {
                  str: 'SARAH',
                  transform: [12, 0, 0, 12, 240, 640],
                  width: 40,
                  height: 12,
                  fontName: 'Courier-Bold',
                },
              ],
            })),
          })),
        }),
      })),
    };

    jest.spyOn(service as any, 'loadPdfJs').mockReturnValue(fakePdfJs as any);

    const result = await service.extract(Buffer.from('pdf'), 'sample.pdf');

    expect(result.source).toBe('native_pdf_text_layer');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].text).toBe('INT. KITCHEN - DAY');
    expect(result.blocks[0].page).toBe(1);
    expect(result.blocks[0].boundingBox).toEqual(
      expect.arrayContaining([72, 88]),
    );
    expect(result.metadata).toMatchObject({
      extractor: 'native_pdf_text_layer',
      pageCount: 1,
      pagesWithBlocks: 1,
    });
  });

  it('returns a warning when no blocks are recovered', async () => {
    const fakePdfJs = {
      getDocument: jest.fn(() => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: jest.fn(async () => ({
            getViewport: jest.fn(() => ({ height: 800 })),
            getTextContent: jest.fn(async () => ({ items: [] })),
          })),
        }),
      })),
    };

    jest.spyOn(service as any, 'loadPdfJs').mockReturnValue(fakePdfJs as any);

    const result = await service.extract(Buffer.from('pdf'), 'empty.pdf');

    expect(result.blocks).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Native PDF extractor did not recover any positioned text blocks.',
      ]),
    );
  });
});
