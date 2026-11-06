import { ApiProperty } from '@nestjs/swagger';

export class PlatformMetricsDto {
  @ApiProperty({
    description:
      'Total projects created within the selected date window (excluding soft-deleted projects).',
    example: 121,
  })
  projectsCreated: number;

  @ApiProperty({
    description:
      'Service uptime percentage over the selected window. This is computed from the running process uptime, so recent restarts reduce this number for wider windows.',
    example: 92.5,
  })
  uptimePercentage: number;

  @ApiProperty({
    description:
      'Average API latency in seconds for HTTP requests observed in the selected window. Null means no requests were observed in that window.',
    example: 1.3,
    nullable: true,
  })
  avgLatencySeconds: number | null;

  @ApiProperty({
    description:
      'Percentage of observed HTTP requests that returned 5xx in the selected window. Null means no requests were observed in that window.',
    example: 1.3,
    nullable: true,
  })
  errorRatePercentage: number | null;

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
