import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClipDiscoveryManager } from './clip-discovery-manager';

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'teslausb-discovery-test-'));
  tempDirs.push(workspace);
  return workspace;
}

async function createFileWithSize(filePath: string, size: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(size));
}

async function createClipSymlink(rootPath: string, relPath: string, targetFilePath: string): Promise<void> {
  const symlinkPath = join(rootPath, relPath);
  await mkdir(dirname(symlinkPath), { recursive: true });
  await symlink(targetFilePath, symlinkPath);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ClipDiscoveryManager', () => {
  it('discovers regular clip files in category folders', async () => {
    const workspace = await createWorkspace();
    const rootPath = join(workspace, 'TeslaCam');
    const archivedListPath = join(workspace, 'mutable', 'sentry_files_archived');

    await createFileWithSize(join(rootPath, 'SavedClips', 'evt1', 'host-dropped.mp4'), 140_000);

    const manager = new ClipDiscoveryManager();
    const result = await manager.discoverPending({
      rootPath,
      archivedListPath,
      includeSavedclips: true,
      includeSentryclips: true,
      includeTrackmodeclips: true,
      includeRecentclips: false,
      minClipSizeBytes: 100_000,
    });

    expect(result.filePaths).toEqual(['SavedClips/evt1/host-dropped.mp4']);
    expect(result.pendingClips.totalFiles).toBe(1);
  });

  it('discovers pending clips, prunes archived, and skips short mp4 clips', async () => {
    const workspace = await createWorkspace();
    const rootPath = join(workspace, 'TeslaCam');
    const targets = join(workspace, 'targets');
    const archivedListPath = join(workspace, 'mutable', 'sentry_files_archived');

    await createFileWithSize(join(targets, 'saved-big.mp4'), 120_000);
    await createFileWithSize(join(targets, 'saved-small.mp4'), 50_000);
    await createFileWithSize(join(targets, 'sentry-big.mp4'), 150_000);
    await createFileWithSize(join(targets, 'track.csv'), 1_000);

    await createClipSymlink(rootPath, 'SavedClips/evt1/saved-big.mp4', join(targets, 'saved-big.mp4'));
    await createClipSymlink(rootPath, 'SavedClips/evt1/saved-small.mp4', join(targets, 'saved-small.mp4'));
    await createClipSymlink(rootPath, 'SentryClips/evt2/sentry-big.mp4', join(targets, 'sentry-big.mp4'));
    await createClipSymlink(rootPath, 'TeslaTrackMode/lap1.csv', join(targets, 'track.csv'));

    await mkdir(join(archivedListPath, '..'), { recursive: true });
    await writeFile(
      archivedListPath,
      ['SavedClips/evt1/saved-big.mp4', 'SavedClips/evt-old/deleted.mp4'].join('\n') + '\n',
      'utf-8',
    );

    const manager = new ClipDiscoveryManager();
    const result = await manager.discoverPending({
      rootPath,
      archivedListPath,
      includeSavedclips: true,
      includeSentryclips: true,
      includeTrackmodeclips: true,
      includeRecentclips: false,
      minClipSizeBytes: 100_000,
      nowEpochSec: Math.floor(Date.now() / 1000),
    });

    expect(result.filePaths).toEqual([
      'SentryClips/evt2/sentry-big.mp4',
      'TeslaTrackMode/lap1.csv',
    ]);
    expect(result.pendingClips.totalFiles).toBe(2);
    expect(result.pendingClips.totalEvents).toBe(1);
    expect(result.previouslyArchivedRetained).toBe(1);
    expect(result.candidatesFiltered).toBe(1);

    const archivedListContent = await readFile(archivedListPath, 'utf-8');
    expect(archivedListContent.trim()).toBe('SavedClips/evt1/saved-big.mp4');
  });

  it('supports category toggles and custom include predicate', async () => {
    const workspace = await createWorkspace();
    const rootPath = join(workspace, 'TeslaCam');
    const targets = join(workspace, 'targets');
    const archivedListPath = join(workspace, 'mutable', 'sentry_files_archived');

    await createFileWithSize(join(targets, 'saved.mp4'), 130_000);
    await createFileWithSize(join(targets, 'sentry.mp4'), 130_000);

    await createClipSymlink(rootPath, 'SavedClips/evt1/saved.mp4', join(targets, 'saved.mp4'));
    await createClipSymlink(rootPath, 'SentryClips/evt1/sentry.mp4', join(targets, 'sentry.mp4'));

    const manager = new ClipDiscoveryManager();
    const result = await manager.discoverPending({
      rootPath,
      archivedListPath,
      includeSavedclips: false,
      includeSentryclips: true,
      includeTrackmodeclips: false,
      includeRecentclips: false,
      includePredicate: (path) => path.endsWith('sentry.mp4'),
    });

    expect(result.filePaths).toEqual(['SentryClips/evt1/sentry.mp4']);
  });

  it('marks archived files with deduplicated sorted output', async () => {
    const workspace = await createWorkspace();
    const archivedListPath = join(workspace, 'mutable', 'sentry_files_archived');
    await mkdir(join(archivedListPath, '..'), { recursive: true });
    await writeFile(archivedListPath, 'SentryClips/a.mp4\n', 'utf-8');

    const manager = new ClipDiscoveryManager();
    await manager.markArchived([
      'SavedClips/b.mp4',
      'SentryClips/a.mp4',
      'RecentClips/c.mp4',
    ], archivedListPath);

    const content = await readFile(archivedListPath, 'utf-8');
    expect(content).toBe([
      'RecentClips/c.mp4',
      'SavedClips/b.mp4',
      'SentryClips/a.mp4',
      '',
    ].join('\n'));
  });

  it('resolves archived files only when no longer symlink-backed', async () => {
    const workspace = await createWorkspace();
    const rootPath = join(workspace, 'TeslaCam');
    const targets = join(workspace, 'targets');

    await createFileWithSize(join(targets, 'kept.mp4'), 130_000);
    await createClipSymlink(rootPath, 'SavedClips/evt1/kept.mp4', join(targets, 'kept.mp4'));

    await mkdir(join(rootPath, 'SavedClips', 'evt1'), { recursive: true });
    await writeFile(join(rootPath, 'SavedClips', 'evt1', 'materialized.mp4'), Buffer.alloc(130_000));

    const manager = new ClipDiscoveryManager();
    const archived = await manager.resolveArchivedFromSource(rootPath, [
      'SavedClips/evt1/kept.mp4',
      'SavedClips/evt1/materialized.mp4',
      'SavedClips/evt1/missing.mp4',
    ]);

    expect(archived).toEqual([
      'SavedClips/evt1/materialized.mp4',
      'SavedClips/evt1/missing.mp4',
    ]);
  });
});
