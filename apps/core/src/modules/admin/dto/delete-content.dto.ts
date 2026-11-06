import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum AdminContentType {
  SCRIPT = 'script',
  RECORDING = 'recording',
  MEDIA = 'media',
}

export class DeleteContentDto {
  @ApiProperty({
    enum: AdminContentType,
    description: 'Type of content to permanently delete',
    example: AdminContentType.RECORDING,
  })
  @IsEnum(AdminContentType)
  contentType: AdminContentType;
}
