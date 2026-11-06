import { RehearsalStatus } from '../enums';

export const VALID_TRANSITIONS: ReadonlyMap<
  RehearsalStatus,
  ReadonlySet<RehearsalStatus>
> = new Map([
  [
    RehearsalStatus.CREATED,
    new Set([RehearsalStatus.PREPARING, RehearsalStatus.CANCELLED]),
  ],
  [
    RehearsalStatus.PREPARING,
    new Set([
      RehearsalStatus.READY,
      RehearsalStatus.FAILED,
      RehearsalStatus.CANCELLED,
    ]),
  ],
  [
    RehearsalStatus.READY,
    new Set([RehearsalStatus.ACTIVE, RehearsalStatus.CANCELLED]),
  ],
  [
    RehearsalStatus.ACTIVE,
    new Set([
      RehearsalStatus.PAUSED,
      RehearsalStatus.COMPLETED,
      RehearsalStatus.FAILED,
      RehearsalStatus.CANCELLED,
    ]),
  ],
  [
    RehearsalStatus.PAUSED,
    new Set([
      RehearsalStatus.ACTIVE,
      RehearsalStatus.COMPLETED,
      RehearsalStatus.FAILED,
      RehearsalStatus.CANCELLED,
    ]),
  ],
  [RehearsalStatus.COMPLETED, new Set<RehearsalStatus>()],
  [RehearsalStatus.FAILED, new Set<RehearsalStatus>()],
  [RehearsalStatus.CANCELLED, new Set<RehearsalStatus>()],
]);

export function assertValidTransition(
  from: RehearsalStatus,
  to: RehearsalStatus,
): void {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new Error(
      `Invalid rehearsal status transition: ${from} → ${to}`,
    );
  }
}
