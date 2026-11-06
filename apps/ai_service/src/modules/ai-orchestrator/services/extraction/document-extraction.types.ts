export type ExtractedBlock = {
  text: string;
  page: number;
  boundingBox?: number[];
  attributes?: Record<string, any>;
};

export type DocumentExtractionResult = {
  source:
    | 'adobe_pdf_extract'
    | 'google_document_ai'
    | 'native_pdf_text_layer'
    | 'legacy';
  jobId?: string;
  warnings?: string[];
  errors?: string[];
  blocks: ExtractedBlock[];
  metadata?: Record<string, any>;
};

export interface DocumentExtractor {
  canHandle(extension: string): boolean;
  extract(buffer: Buffer, fileName: string): Promise<DocumentExtractionResult>;
  readonly isConfigured: boolean;
}
