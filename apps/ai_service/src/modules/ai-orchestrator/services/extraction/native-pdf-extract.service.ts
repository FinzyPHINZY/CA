import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentExtractionResult,
  DocumentExtractor,
  ExtractedBlock,
} from './document-extraction.types';

type PdfJsTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
};

@Injectable()
export class NativePdfExtractService implements DocumentExtractor {
  private readonly logger = new Logger(NativePdfExtractService.name);

  get isConfigured(): boolean {
    return true;
  }

  canHandle(extension: string): boolean {
    return extension.toLowerCase() === 'pdf';
  }

  async extract(
    buffer: Buffer,
    fileName: string,
  ): Promise<DocumentExtractionResult> {
    const pdfjs = this.loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
    });
    const document = loadingTask.promise
      ? await loadingTask.promise
      : await loadingTask;
    const totalPages =
      typeof document?.numPages === 'number' ? document.numPages : 0;
    const blocks: ExtractedBlock[] = [];
    let pagesWithBlocks = 0;

    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const items = Array.isArray(textContent?.items) ? textContent.items : [];
      const pageBlocks = items
        .map((item) =>
          this.mapTextItemToBlock(
            item as PdfJsTextItem,
            pageIndex,
            viewport?.height,
          ),
        )
        .filter((block): block is ExtractedBlock => Boolean(block));

      if (pageBlocks.length > 0) {
        pagesWithBlocks += 1;
        blocks.push(...pageBlocks);
      }
    }

    this.logger.log(
      `[Native PDF Extract] Parsed ${blocks.length} text items across ${totalPages} page(s) for ${fileName}`,
    );

    return {
      source: 'native_pdf_text_layer',
      warnings:
        pagesWithBlocks === 0
          ? ['Native PDF extractor did not recover any positioned text blocks.']
          : undefined,
      blocks,
      metadata: {
        fileName,
        extractor: 'native_pdf_text_layer',
        pageCount: totalPages,
        pagesWithBlocks,
      },
    };
  }

  private mapTextItemToBlock(
    item: PdfJsTextItem,
    pageNumber: number,
    pageHeight: number | undefined,
  ): ExtractedBlock | null {
    const text = item?.str?.replace(/\s+/g, ' ').trim();
    if (!text) {
      return null;
    }

    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = typeof transform[4] === 'number' ? transform[4] : 0;
    const y = typeof transform[5] === 'number' ? transform[5] : 0;
    const width = typeof item.width === 'number' ? item.width : text.length * 5;
    const height =
      typeof item.height === 'number'
        ? item.height
        : typeof transform[0] === 'number'
          ? Math.abs(transform[0])
          : 10;
    const normalizedTop =
      typeof pageHeight === 'number' ? Math.max(0, pageHeight - y - height) : y;
    const rotationDegrees =
      transform.length >= 2
        ? Number(
            (
              (Math.atan2(transform[1] || 0, transform[0] || 1) * 180) /
              Math.PI
            ).toFixed(2),
          )
        : 0;
    const boundingBox = [
      Number(x.toFixed(2)),
      Number(normalizedTop.toFixed(2)),
      Number((x + width).toFixed(2)),
      Number(normalizedTop.toFixed(2)),
      Number((x + width).toFixed(2)),
      Number((normalizedTop + height).toFixed(2)),
      Number(x.toFixed(2)),
      Number((normalizedTop + height).toFixed(2)),
    ];

    const attributes: Record<string, any> = {
      fontName: item.fontName || null,
      fontSize: Number(height.toFixed(2)),
      rotationDegrees,
      segmentType: 'textItem',
    };

    return {
      text,
      page: pageNumber,
      boundingBox,
      attributes,
    };
  }

  private loadPdfJs(): any {
    // pdf-parse already brings this legacy pdf.js bundle into the workspace.
    // Reuse it here so we can recover positioned text items without adding a new dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  }
}
