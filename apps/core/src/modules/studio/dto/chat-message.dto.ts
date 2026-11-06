import { ApiProperty } from '@nestjs/swagger';

export class ChatMessageDto {
  @ApiProperty({ description: 'Unique message ID', format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Sender user ID', format: 'uuid' })
  senderId: string;

  @ApiProperty({ description: 'Sender display name' })
  senderName: string;

  @ApiProperty({ description: 'Sender avatar URL', required: false })
  senderAvatar?: string;

  @ApiProperty({
    enum: ['text', 'file'],
    description: 'Message type',
  })
  type: 'text' | 'file';

  @ApiProperty({
    description: 'Text content (max 2000 chars)',
    required: false,
  })
  content?: string;

  @ApiProperty({
    description: 'File URL from file service',
    required: false,
  })
  fileUrl?: string;

  @ApiProperty({ description: 'Original file name', required: false })
  fileName?: string;

  @ApiProperty({ description: 'File size in bytes', required: false })
  fileSize?: number;

  @ApiProperty({ description: 'MIME type of the file', required: false })
  mimeType?: string;

  @ApiProperty({ description: 'Message timestamp (epoch ms)' })
  timestamp: number;
}
