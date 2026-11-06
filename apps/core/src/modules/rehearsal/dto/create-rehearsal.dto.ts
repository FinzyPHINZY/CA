import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNotEmpty,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { RehearsalPartnerType } from '@app/common';

export class CreateRehearsalDto {
  @ApiProperty({
    description:
      'Scene ID that this rehearsal is for. The scriptId and projectId will be automatically derived from the scene.',
    example: '323e4567-e89b-12d3-a456-426614174002',
    required: true,
  })
  @IsUUID('4', { message: 'Scene ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Scene ID is required' })
  sceneId: string;

  @ApiProperty({
    description: 'Type of rehearsal partner',
    enum: RehearsalPartnerType,
    example: RehearsalPartnerType.USER,
    required: true,
  })
  @IsEnum(RehearsalPartnerType, { message: 'Invalid rehearsal partner type' })
  @IsNotEmpty({ message: 'Rehearsal partner type is required' })
  rehearsalPartnerType: RehearsalPartnerType;

  @ApiPropertyOptional({
    description:
      'User ID of the partner (required when rehearsalPartnerType is USER)',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
    required: false,
  })
  @ValidateIf((o) => o.rehearsalPartnerType === RehearsalPartnerType.USER)
  @IsUUID('4', { message: 'Rehearsal partner user ID must be a valid UUID' })
  @IsNotEmpty({
    message: 'Rehearsal partner user ID is required when partner type is USER',
  })
  rehearsalPartnerUserId?: string | null;

  @ApiPropertyOptional({
    description:
      'Name of the AI partner (required when rehearsalPartnerType is AI)',
    example: 'AI Character Name',
    required: false,
  })
  @ValidateIf((o) => o.rehearsalPartnerType === RehearsalPartnerType.AI)
  @IsString({ message: 'AI partner name must be a string' })
  @IsNotEmpty({
    message: 'AI partner name is required when partner type is AI',
  })
  rehearsalPartnerAiName?: string | null;

  @ApiPropertyOptional({
    description:
      'Description of the AI partner (optional when rehearsalPartnerType is AI)',
    example: 'A helpful AI assistant character with a friendly personality',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'AI partner description must be a string' })
  rehearsalPartnerAiDescription?: string | null;

  @ApiPropertyOptional({
    description:
      'Image URL for the AI partner (optional when rehearsalPartnerType is AI)',
    example: 'https://example.com/ai-character-avatar.jpg',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'AI partner image URL must be a string' })
  rehearsalPartnerAiImage?: string | null;
}
