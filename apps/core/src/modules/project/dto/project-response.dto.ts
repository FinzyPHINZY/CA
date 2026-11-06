import {
  AnalysisOutboxStatus,
  ProjectAnalysisState,
  ProjectStatus,
  ScriptStatus,
} from '@app/common';
import { BaseResponseDto } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';

export class ProjectResponseDataDto {
  @ApiProperty({
    description: 'Project unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Owner user identifier',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
  })
  userId: string;

  @ApiProperty({
    description: 'Project title',
    example: 'My New Project',
  })
  title: string;

  @ApiProperty({
    description: 'Project description',
    example: 'A detailed description of the project',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    description: 'Lifecycle status of the project',
    enum: ProjectStatus,
    example: ProjectStatus.DRAFT,
  })
  status: ProjectStatus;
}

export class CreateProjectResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Created project payload',
    type: ProjectResponseDataDto,
  })
  data: ProjectResponseDataDto;
}

export class AttachedProjectScriptDto {
  @ApiProperty({
    description: 'Created script identifier',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  id: string;

  @ApiProperty({
    description: 'Project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  projectId: string;

  @ApiProperty({
    description: 'Analysis task identifier for this script',
    example: '987fcdeb-51a2-43f7-8b9c-123456789abc',
  })
  taskId: string;

  @ApiProperty({
    description: 'Source media identifier used to create the script',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  mediaId: string;

  @ApiProperty({
    description: 'Current script status',
    enum: ScriptStatus,
    example: ScriptStatus.UPLOADED,
  })
  status: ScriptStatus;

  @ApiProperty({
    description: 'Script title',
    example: 'Scene One',
  })
  title: string;

  @ApiProperty({
    description: 'File URL for the source script asset',
    example: 'https://cdn.example.com/media-1.pdf',
  })
  fileUrl: string;
}

export class AttachProjectScriptsResponseDataDto {
  @ApiProperty({
    description: 'Project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  projectId: string;

  @ApiProperty({
    description: 'Original media IDs sent by the client',
    type: [String],
    example: [
      '123e4567-e89b-12d3-a456-426614174000',
      '223e4567-e89b-12d3-a456-426614174001',
      '123e4567-e89b-12d3-a456-426614174000',
    ],
  })
  requestedMediaIds: string[];

  @ApiProperty({
    description: 'Request media IDs after deduplication',
    type: [String],
    example: [
      '123e4567-e89b-12d3-a456-426614174000',
      '223e4567-e89b-12d3-a456-426614174001',
    ],
  })
  deduplicatedMediaIds: string[];

  @ApiProperty({
    description: 'New scripts created from the request',
    type: [AttachedProjectScriptDto],
  })
  createdScripts: AttachedProjectScriptDto[];

  @ApiProperty({
    description: 'Media IDs skipped because they were already attached',
    type: [String],
    example: ['223e4567-e89b-12d3-a456-426614174001'],
  })
  skippedMediaIds: string[];

  @ApiProperty({
    description: 'Number of outbox jobs created for analysis dispatch',
    example: 1,
  })
  outboxJobsCreated: number;
}

export class AttachProjectScriptsResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Project script attachment result',
    type: AttachProjectScriptsResponseDataDto,
  })
  data: AttachProjectScriptsResponseDataDto;
}

export class RetryProjectScriptAnalysisResponseDataDto {
  @ApiProperty({
    description: 'Project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  projectId: string;

  @ApiProperty({
    description: 'Retried script identifier',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  scriptId: string;

  @ApiProperty({
    description: 'New analysis task identifier',
    example: '987fcdeb-51a2-43f7-8b9c-123456789abc',
  })
  taskId: string;

  @ApiProperty({
    description: 'Current script status after queuing retry',
    enum: ScriptStatus,
    example: ScriptStatus.UPLOADED,
  })
  status: ScriptStatus;

  @ApiProperty({
    description: 'Outbox job identifier created for the retry',
    example: '423e4567-e89b-12d3-a456-426614174003',
  })
  outboxJobId: string;
}

export class RetryProjectScriptAnalysisResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Retry queueing result',
    type: RetryProjectScriptAnalysisResponseDataDto,
  })
  data: RetryProjectScriptAnalysisResponseDataDto;
}

export class ProjectOutboxJobItemDto {
  @ApiProperty({
    description: 'Outbox job identifier',
    example: '423e4567-e89b-12d3-a456-426614174003',
  })
  id: string;

  @ApiProperty({
    description: 'Project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  projectId: string;

  @ApiProperty({
    description: 'Script identifier associated with the outbox job',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  scriptId: string;

  @ApiProperty({
    description: 'Analysis task identifier',
    example: '987fcdeb-51a2-43f7-8b9c-123456789abc',
  })
  taskId: string;

  @ApiProperty({
    description: 'Event type published to the bus',
    example: 'ai.script-analysis',
  })
  eventType: string;

  @ApiProperty({
    description: 'Current outbox job status',
    enum: AnalysisOutboxStatus,
    example: AnalysisOutboxStatus.FAILED,
  })
  status: AnalysisOutboxStatus;

  @ApiProperty({
    description: 'Serialized event payload for this outbox job',
    type: 'object',
    additionalProperties: true,
    example: {
      projectId: '123e4567-e89b-12d3-a456-426614174000',
      userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
      mediaId: '123e4567-e89b-12d3-a456-426614174000',
      taskId: '987fcdeb-51a2-43f7-8b9c-123456789abc',
      scriptIndex: 0,
    },
  })
  payload: Record<string, any>;

  @ApiProperty({
    description: 'Number of publish attempts made so far',
    example: 3,
  })
  attempts: number;

  @ApiProperty({
    description: 'Last dispatcher error, if any',
    example: 'RabbitMQ connection unavailable',
    nullable: true,
  })
  lastError: string | null;

  @ApiProperty({
    description: 'Timestamp of the last dispatch attempt',
    example: '2026-03-13T06:10:00.000Z',
    nullable: true,
  })
  lastAttemptAt: Date | null;

  @ApiProperty({
    description: 'Timestamp when the next retry is eligible',
    example: '2026-03-13T06:11:00.000Z',
  })
  nextAttemptAt: Date;

  @ApiProperty({
    description: 'Timestamp when the job was successfully dispatched',
    example: '2026-03-13T06:12:00.000Z',
    nullable: true,
  })
  dispatchedAt: Date | null;

  @ApiProperty({
    description: 'Whether the job currently appears stuck',
    example: true,
  })
  isStuck: boolean;

  @ApiProperty({
    description: 'Row creation timestamp',
    example: '2026-03-13T06:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Row update timestamp',
    example: '2026-03-13T06:10:00.000Z',
  })
  updatedAt: Date;
}

export class ProjectOutboxFiltersDto {
  @ApiProperty({
    description: 'Applied outbox status filter',
    enum: AnalysisOutboxStatus,
    nullable: true,
    example: null,
  })
  status: AnalysisOutboxStatus | null;

  @ApiProperty({
    description: 'Whether dispatched jobs were included',
    example: false,
  })
  includeDispatched: boolean;

  @ApiProperty({
    description: 'Whether only stuck jobs were requested',
    example: true,
  })
  onlyStuck: boolean;

  @ApiProperty({
    description: 'Maximum number of rows returned',
    example: 20,
  })
  limit: number;
}

export class ProjectOutboxSummaryDto {
  @ApiProperty({
    description: 'Total number of outbox jobs for the project',
    example: 3,
  })
  totalJobs: number;

  @ApiProperty({
    description: 'Pending outbox jobs count',
    example: 1,
  })
  pendingJobs: number;

  @ApiProperty({
    description: 'Processing outbox jobs count',
    example: 0,
  })
  processingJobs: number;

  @ApiProperty({
    description: 'Dispatched outbox jobs count',
    example: 1,
  })
  dispatchedJobs: number;

  @ApiProperty({
    description: 'Failed outbox jobs count',
    example: 1,
  })
  failedJobs: number;

  @ApiProperty({
    description: 'Returned jobs currently considered stuck',
    example: 2,
  })
  stuckJobs: number;
}

export class ProjectOutboxJobsResponseDataDto {
  @ApiProperty({
    description: 'Project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  projectId: string;

  @ApiProperty({
    description: 'Threshold used to consider processing/pending jobs stale',
    example: 300000,
  })
  staleAfterMs: number;

  @ApiProperty({
    description: 'Applied query filters',
    type: ProjectOutboxFiltersDto,
  })
  filters: ProjectOutboxFiltersDto;

  @ApiProperty({
    description: 'Aggregate outbox counts for the project',
    type: ProjectOutboxSummaryDto,
  })
  summary: ProjectOutboxSummaryDto;

  @ApiProperty({
    description: 'Outbox jobs returned for inspection',
    type: [ProjectOutboxJobItemDto],
  })
  items: ProjectOutboxJobItemDto[];
}

export class ProjectOutboxJobsResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'Project outbox inspection result',
    type: ProjectOutboxJobsResponseDataDto,
  })
  data: ProjectOutboxJobsResponseDataDto;
}

export class ProjectAnalysisSummaryDto {
  @ApiProperty({
    description: 'Derived project analysis state',
    enum: ProjectAnalysisState,
    example: ProjectAnalysisState.READY,
  })
  analysisState: ProjectAnalysisState;

  @ApiProperty({
    description: 'Whether one or more scripts require user attention',
    example: false,
  })
  attentionRequired: boolean;

  @ApiProperty({ example: 1 })
  totalScripts: number;

  @ApiProperty({ example: 0 })
  uploadedScripts: number;

  @ApiProperty({ example: 0 })
  processingScripts: number;

  @ApiProperty({ example: 1 })
  analyzedScripts: number;

  @ApiProperty({ example: 0 })
  failedScripts: number;
}
