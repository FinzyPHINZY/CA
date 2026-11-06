import { ApiProperty } from '@nestjs/swagger';

export class UserMetricsDto {
  @ApiProperty({
    description:
      'Total new actor/reader signups created within the selected date window.',
    example: 98,
  })
  totalSignups: number;

  @ApiProperty({
    description:
      'Total distinct active actor/reader users within the selected date window (users who logged in during the window and are not disabled or soft-deleted).',
    example: 190,
  })
  activeUsers: number;

  @ApiProperty({
    description: 'Resolved start of the metrics window (inclusive).',
    example: '2026-05-01T00:00:00.000Z',
  })
  from: string;

  @ApiProperty({
    description: 'Resolved end of the metrics window (inclusive).',
    example: '2026-05-06T23:59:59.999Z',
  })
  to: string;
}
