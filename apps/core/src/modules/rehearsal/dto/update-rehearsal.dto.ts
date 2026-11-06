import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { RehearsalPartnerType } from '@app/common';

export class UpdateRehearsalDto {
  @ApiPropertyOptional({
    description: 'Type of rehearsal partner',
    enum: RehearsalPartnerType,
    example: RehearsalPartnerType.AI,
    required: false,
  })
  @IsOptional()
  @IsEnum(RehearsalPartnerType, { message: 'Invalid rehearsal partner type' })
  rehearsalPartnerType?: RehearsalPartnerType;

  @ApiPropertyOptional({
    description:
      'User ID of the partner (required when rehearsalPartnerType is USER)',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
    required: false,
  })
  @ValidateIf((o) => o.rehearsalPartnerType === RehearsalPartnerType.USER)
  @IsUUID('4', { message: 'Rehearsal partner user ID must be a valid UUID' })
  @IsOptional()
  rehearsalPartnerUserId?: string | null;

  @ApiPropertyOptional({
    description:
      'Name of the AI partner (required when rehearsalPartnerType is AI)',
    example: 'AI Character Name',
    required: false,
  })
  @ValidateIf((o) => o.rehearsalPartnerType === RehearsalPartnerType.AI)
  @IsString({ message: 'AI partner name must be a string' })
  @IsOptional()
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
