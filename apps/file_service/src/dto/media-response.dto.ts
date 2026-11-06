import { ApiProperty } from '@nestjs/swagger';
import { MediaType } from '@app/common';

export class MediaResponseDto {
  @ApiProperty({
    description: 'Unique identifier for the media record',
    example: '123e4567-e89b-12d3-a456-426614174000',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    description: 'Type of media file',
    enum: MediaType,
    example: MediaType.DOCUMENT,
  })
  type: MediaType;

  @ApiProperty({
    description: 'Full URL to access the file',
    example:
      'https://bucket.s3.amazonaws.com/documents/1704067200000-document.pdf',
  })
  url: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 1024000,
    type: Number,
  })
  size: number;

  @ApiProperty({
    description: 'User ID who uploaded the file',
    example: 'user-123',
  })
  userId: string;

  @ApiProperty({
    description: 'Original file name',
    example: 'document.pdf',
    nullable: true,
    required: false,
  })
  fileName: string | null;

  @ApiProperty({
    description: 'MIME type of the file',
    example: 'application/pdf',
    nullable: true,
    required: false,
  })
  contentType: string | null;

  @ApiProperty({
    description: 'S3 object key for reference',
    example: 'documents/1704067200000-document.pdf',
    nullable: true,
    required: false,
  })
  s3Key: string | null;

  @ApiProperty({
    description: 'Date and time when the record was created',
    example: '2025-01-15T10:30:00Z',
    type: Date,
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Date and time when the record was last updated',
    example: '2025-01-15T10:30:00Z',
    type: Date,
  })
  updatedAt: Date;

  @ApiProperty({
    description:
      'Date and time when the record was soft deleted (if applicable)',
    example: null,
    type: Date,
    nullable: true,
    required: false,
  })
  deletedAt?: Date | null;
}
