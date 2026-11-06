import { ApiProperty } from '@nestjs/swagger';

export class FileMetadataResponseDto {
  @ApiProperty({
    description: 'S3 object key (file path)',
    example: 'documents/1704067200000-document.pdf',
  })
  key: string;

  @ApiProperty({
    description: 'Full URL to access the file',
    example:
      'https://bucket.s3.amazonaws.com/documents/1704067200000-document.pdf',
  })
  url: string;

  @ApiProperty({
    description: 'Original file name',
    example: 'document.pdf',
  })
  fileName: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 1024000,
    type: Number,
  })
  fileSize: number;

  @ApiProperty({
    description: 'MIME type of the file',
    example: 'application/pdf',
  })
  contentType: string;

  @ApiProperty({
    description: 'Date and time when the file was uploaded',
    example: '2025-01-15T10:30:00Z',
    type: Date,
  })
  uploadedAt: Date;
}
