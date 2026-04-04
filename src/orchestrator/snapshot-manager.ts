/**
 * Legacy lineage:
 * - run/make_snapshot.sh
 * - run/release_snapshot.sh
 */
export interface SnapshotDecision {
  shouldCreate: boolean;
  reason: string;
}

export class SnapshotManager {
  constructor(private readonly minIntervalSec: number = 300) {}

  shouldCreateSnapshot(lastSnapshotEpoch: number | null, nowEpoch: number): SnapshotDecision {
    if (lastSnapshotEpoch === null) {
      return { shouldCreate: true, reason: 'no_previous_snapshot' };
    }

    const elapsed = nowEpoch - lastSnapshotEpoch;
    if (elapsed >= this.minIntervalSec) {
      return { shouldCreate: true, reason: 'interval_elapsed' };
    }

    return { shouldCreate: false, reason: 'interval_not_elapsed' };
  }
}
