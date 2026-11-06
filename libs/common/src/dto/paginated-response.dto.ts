import { ApiProperty } from '@nestjs/swagger';

export class PaginatedResponseDto<T> {
  @ApiProperty({
    description: 'Array of items for the current page',
  })
  data: T[];

  @ApiProperty({
    description: 'Total number of items across all pages',
    example: 100,
  })
  total: number;

  @ApiProperty({
    description: 'Current page number',
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
    example: 10,
  })
  totalPages: number;

  @ApiProperty({
    description: 'Indicates if there is a next page',
    example: true,
  })
  hasNext: boolean;

  @ApiProperty({
    description: 'Indicates if there is a previous page',
    example: false,
  })
  hasPrev: boolean;
}
