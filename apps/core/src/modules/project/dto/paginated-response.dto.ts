import { ApiProperty } from '@nestjs/swagger';
import { Project } from '@app/common';

export class PaginatedProjectResponseDto {
  @ApiProperty({
    description:
      'Array of projects with optional totals (scenes, recordings, rehearsals)',
    type: [Project],
  })
  data: (Project & {
    totalScenes?: number;
    totalRecordings?: number;
    totalRehersals?: number;
  })[];

  @ApiProperty({
    description: 'Total number of projects matching the query',
    example: 42,
  })
  total: number;

  @ApiProperty({
    description: 'Current page number (1-indexed)',
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Number of items per page',
    example: 10,
  })
  limit: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 5,
  })
  totalPages: number;

  @ApiProperty({
    description: 'Whether there is a next page',
    example: true,
  })
  hasNext: boolean;

  @ApiProperty({
    description: 'Whether there is a previous page',
    example: false,
  })
  hasPrev: boolean;
}
