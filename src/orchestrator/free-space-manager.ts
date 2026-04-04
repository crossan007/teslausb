/**
 * Legacy lineage:
 * - run/manage_free_space.sh
 */
export interface FreeSpaceDecision {
  needsCleanup: boolean;
  freePercent: number;
  targetBytesToFree: number;
}

export class FreeSpaceManager {
  constructor(
    private readonly minFreePercent: number = 10,
    private readonly minFreeBytes: number = 512 * 1024 * 1024,
  ) {}

  evaluate(freeBytes: number, totalBytes: number): FreeSpaceDecision {
    const safeTotal = Math.max(totalBytes, 1);
    const freePercent = (freeBytes / safeTotal) * 100;

    const needsCleanup = freePercent < this.minFreePercent || freeBytes < this.minFreeBytes;

    if (!needsCleanup) {
      return {
        needsCleanup: false,
        freePercent,
        targetBytesToFree: 0,
      };
    }

    const targetPercentBytes = Math.ceil((this.minFreePercent / 100) * safeTotal);
    const targetBytes = Math.max(targetPercentBytes, this.minFreeBytes);

    return {
      needsCleanup: true,
      freePercent,
      targetBytesToFree: Math.max(targetBytes - freeBytes, 0),
    };
  }
}
