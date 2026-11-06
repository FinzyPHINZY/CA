/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SessionSharedFileAnalysisStatus } from '../enums/session-shared-file.enum';
import { BaseEntity } from './base.entity';
import { Rehersal } from './rehersal.entity';

// Files participants share inside a booked reader session (Studio).
// Pure side-channel — no impact on rehearsal/turn state. Session-scoped:
// soft-deleted at session end, hard-deleted by retention cron after 24h grace.
//
// Analysis (Phase 4.0 parser → optional Gemini) is opt-in per file. Result
// cached cross-session by `contentHash` so the same PDF analyzed once is free
// for everyone else who shares it.
@Entity({ name: 'session_shared_files', schema: 'studio_schema' })
@Index(['rehearsalId', 'deletedAt'])
@Index(['contentHash', 'analysisStatus'])
@Index('IDX_session_shared_files_deletedAt_partial', ['deletedAt'], {
  where: '"deletedAt" IS NOT NULL',
})
export class SessionSharedFile extends BaseEntity {
  @Column({ nullable: false })
  rehearsalId: string;

  @ManyToOne(() => Rehersal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rehearsalId' })
  rehearsal: Rehersal;

  // plain UUID — auth-service user data fetched via API composition, never joined
  @Column({ nullable: false })
  uploaderUserId: string;

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'integer' })
  fileSize: number;

  @Column({ type: 'varchar', length: 255 })
  mimeType: string;

  @Column({ type: 'varchar', length: 16 })
  extension: string;

  @Column({ type: 'varchar', length: 1024 })
  s3Key: string;

  @Column({ type: 'varchar', length: 64 })
  contentHash: string;

  @Column({
    type: 'enum',
    enum: SessionSharedFileAnalysisStatus,
    default: SessionSharedFileAnalysisStatus.NONE,
  })
  analysisStatus: SessionSharedFileAnalysisStatus;

  @Column({ type: 'jsonb', nullable: true })
  analysisResult: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  analysisError: string | null;

  @Column({ type: 'uuid', nullable: true })
  analysisRequestedBy: string | null;

  @Column({ type: 'timestamp', nullable: true })
  analysisRequestedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  analysisCompletedAt: Date | null;

  // idempotency key supplied by the client on attach. Prevents duplicate rows
  // when the FE retries a flaky POST. Unique within (rehearsalId, uploaderUserId).
  @Column({ type: 'uuid', nullable: true })
  clientUploadId: string | null;
}
