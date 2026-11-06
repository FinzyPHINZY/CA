import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { ReaderWorkSamplePublicDto } from '../../reader-profile/dto/reader-profile-response.dto';

export class AvailabilitySlotDto {
  @ApiProperty({ description: 'Slot start time (HH:mm)', example: '09:00' })
  start: string;

  @ApiProperty({ description: 'Slot end time (HH:mm)', example: '11:00' })
  end: string;
}

export class AvailableDayDto {
  @ApiProperty({
    description: 'Day of the week',
    example: 'MONDAY',
    enum: [
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ],
  })
  day: string;

  @ApiProperty({
    description: 'Time slots available on this day',
    type: [AvailabilitySlotDto],
  })
  slots: AvailabilitySlotDto[];
}

export class ReaderPublicProfileDataDto {
  @ApiProperty({
    description: 'Reader profile identifier',
    example: 'reader-profile-uuid',
  })
  id: string;

  @ApiProperty({
    description: 'Owner user identifier',
    example: 'user-uuid',
  })
  userId: string;

  @ApiProperty({
    description: 'Resolved public display name',
    example: 'Jane Smith',
    nullable: true,
  })
  readerName: string | null;

  @ApiProperty({
    description: 'Resolved public avatar URL',
    example: 'https://cdn.example.com/avatar.jpg',
    nullable: true,
  })
  readerAvatar: string | null;

  @ApiProperty({
    description: 'Reader headline',
    example: 'Award-winning voice actor',
    nullable: true,
  })
  headline: string | null;

  @ApiProperty({
    description: 'Public work samples without internal media identifiers',
    type: [ReaderWorkSamplePublicDto],
  })
  workSamples: ReaderWorkSamplePublicDto[];

  @ApiProperty({
    description:
      "Reader's weekly availability schedule derived from recurring template slots",
    type: [AvailableDayDto],
  })
  availableSchedule: AvailableDayDto[];
}

export class ReaderPublicProfileResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Public reader profile payload',
    type: ReaderPublicProfileDataDto,
  })
  data: ReaderPublicProfileDataDto;
}
