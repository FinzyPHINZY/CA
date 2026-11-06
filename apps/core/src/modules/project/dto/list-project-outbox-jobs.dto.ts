import { AnalysisOutboxStatus } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class ListProjectOutboxJobsDto {
  private static toBoolean(value: unknown): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }

    return Boolean(value);
  }

  @ApiPropertyOptional({
    description: 'Optional outbox status filter.',
    enum: AnalysisOutboxStatus,
    example: AnalysisOutboxStatus.FAILED,
  })
  @IsOptional()
  @IsEnum(AnalysisOutboxStatus)
  status?: AnalysisOutboxStatus;

  @ApiPropertyOptional({
    description:
      'Include dispatched jobs in the response. Defaults to false for debug-oriented output.',
    example: false,
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => ListProjectOutboxJobsDto.toBoolean(value))
  @IsBoolean()
  includeDispatched?: boolean;

  @ApiPropertyOptional({
    description:
      'Return only jobs that appear stuck: failed jobs, stale processing jobs, or overdue pending jobs.',
    example: true,
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => ListProjectOutboxJobsDto.toBoolean(value))
  @IsBoolean()
  onlyStuck?: boolean;

  @ApiPropertyOptional({
    description: 'Maximum number of jobs to return.',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
