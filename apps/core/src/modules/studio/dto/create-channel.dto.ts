import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class CreateChannelDto {
  @ApiProperty({
    description:
      'Booking ID to associate the channel with (for reader sessions)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: 'Booking ID must be a valid UUID' })
  bookingId?: string;

  @ApiProperty({
    description:
      'Rehearsal ID to associate the channel with (for AI/solo rehearsals)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: 'Rehearsal ID must be a valid UUID' })
  @ValidateIf((o) => !o.bookingId)
  rehearsalId?: string;
}
