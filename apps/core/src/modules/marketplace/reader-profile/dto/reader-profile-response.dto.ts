import {
  OnboardingStep,
  ReaderWorkSampleSourceType,
  WorkSampleType,
} from '@app/common';
import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';

export class ReaderWorkSampleInternalDto {
  @ApiProperty({
    description: 'Work sample identifier',
    example: 'work-sample-uuid',
  })
  id: string;

  @ApiProperty({
    description: 'Work sample title',
    example: 'Commercial Reel 2026',
  })
  title: string;

  @ApiProperty({
    description: 'Resolved work sample URL',
    example:
      'https://bucket.s3.amazonaws.com/marketplace/readers/user-uuid/work-samples/1710000000000-abcd1234-commercial_reel.mp4',
  })
  url: string;

  @ApiProperty({
    description: 'Optional work sample thumbnail URL',
    example: 'https://cdn.example.com/thumbnails/reel-2026.jpg',
    nullable: true,
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    description: 'Work sample media type',
    enum: WorkSampleType,
    example: WorkSampleType.VIDEO,
  })
  type: WorkSampleType;

  @ApiProperty({
    description: 'Source of the work sample',
    enum: ReaderWorkSampleSourceType,
    example: ReaderWorkSampleSourceType.UPLOAD,
  })
  sourceType: ReaderWorkSampleSourceType;

  @ApiProperty({
    description:
      'Owned media identifier for uploaded work samples. Null for external links.',
    example: '123e4567-e89b-12d3-a456-426614174000',
    nullable: true,
  })
  mediaId: string | null;

  @ApiProperty({
    description: 'Work sample creation timestamp',
    example: '2026-03-13T06:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Work sample update timestamp',
    example: '2026-03-13T06:00:00.000Z',
  })
  updatedAt: Date;
}

export class ReaderWorkSamplePublicDto {
  @ApiProperty({
    description: 'Work sample identifier',
    example: 'work-sample-uuid',
  })
  id: string;

  @ApiProperty({
    description: 'Work sample title',
    example: 'Commercial Reel 2026',
  })
  title: string;

  @ApiProperty({
    description: 'Resolved work sample URL',
    example:
      'https://bucket.s3.amazonaws.com/marketplace/readers/user-uuid/work-samples/1710000000000-abcd1234-commercial_reel.mp4',
  })
  url: string;

  @ApiProperty({
    description: 'Optional work sample thumbnail URL',
    example: 'https://cdn.example.com/thumbnails/reel-2026.jpg',
    nullable: true,
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    description: 'Work sample media type',
    enum: WorkSampleType,
    example: WorkSampleType.VIDEO,
  })
  type: WorkSampleType;

  @ApiProperty({
    description: 'Source of the work sample',
    enum: ReaderWorkSampleSourceType,
    example: ReaderWorkSampleSourceType.UPLOAD,
  })
  sourceType: ReaderWorkSampleSourceType;

  @ApiProperty({
    description: 'Work sample creation timestamp',
    example: '2026-03-13T06:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Work sample update timestamp',
    example: '2026-03-13T06:00:00.000Z',
  })
  updatedAt: Date;
}

export class ReaderWorkSamplesUpdatedDataDto {
  @ApiProperty({
    description: 'Reader profile identifier',
    example: 'reader-profile-uuid',
  })
  id: string;

  @ApiProperty({
    description: 'Current onboarding step after saving work samples',
    enum: OnboardingStep,
    example: OnboardingStep.SESSION_RATES,
  })
  onboardingStep: OnboardingStep;
}

export class ReaderWorkSamplesUpdatedResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Updated reader profile state after saving work samples',
    type: ReaderWorkSamplesUpdatedDataDto,
  })
  data: ReaderWorkSamplesUpdatedDataDto;
}

export class ReaderProfileMeDataDto {
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
    description: 'Reader headline',
    example: 'Award-winning voice actor',
    nullable: true,
  })
  headline: string | null;

  @ApiProperty({
    description: 'Reader work samples with internal upload metadata',
    type: [ReaderWorkSampleInternalDto],
  })
  workSamples: ReaderWorkSampleInternalDto[];
}

export class ReaderProfileMeResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Internal reader profile payload',
    type: ReaderProfileMeDataDto,
  })
  data: ReaderProfileMeDataDto;
}
