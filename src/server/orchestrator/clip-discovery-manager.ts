/**
 * Legacy lineage:
 * - run/archiveloop (archive_teslacam_clips candidate discovery + pruning)
 * - /mutable/sentry_files_archived tracking file
 */
import { Dirent } from 'fs';
import { mkdir, opendir, readFile, stat, lstat, writeFile } from 'fs/promises';
import { dirname, posix as posixPath } from 'path';
import { PendingClips, Snapshot } from '../../types';
import { blake2s256 } from '../shared';

const DEFAULT_MIN_CLIP_SIZE_BYTES = 100_000;
const DEFAULT_STAT_CONCURRENCY = 32;

export interface ClipDiscoveryOptions {
  rootPath: string;
  archivedListPath: string;
  includeSavedclips?: boolean;
  includeSentryclips?: boolean;
  includeTrackmodeclips?: boolean;
  includeRecentclips?: boolean;
  minClipSizeBytes?: number;
  statConcurrency?: number;
  includePredicate?: (relativePath: string) => boolean;
  nowEpochSec?: number;
}

export interface ClipDiscoveryResult {
  rootPath: string;
  clips: ClipMetadata[];
  filePaths: string[];
  pendingClips: PendingClips;
  candidatesDiscovered: number;
  candidatesFiltered: number;
  previouslyArchivedRetained: number;
  snapshot?: Snapshot;
}

interface ClipCategoryConfig {
  directory: string;
  enabled: boolean;
}

export interface ClipMetadata {
  key: string;
  fileName: string;
  relPath: string;
  absPath: string;
  ageSec: number;
  isSymlink: boolean;
}

export class ClipDiscoveryManager {
  async discoverPending(options: ClipDiscoveryOptions): Promise<ClipDiscoveryResult> {
    const candidatePaths = await this.discoverCandidateSymlinks(options);
    const archivedSet = await this.readArchivedSet(options.archivedListPath);

    const retainedArchived = new Set<string>();
    for (const path of candidatePaths) {
      if (archivedSet.has(path)) {
        retainedArchived.add(path);
      }
    }

    await this.writeArchivedSet(options.archivedListPath, retainedArchived);

    const pendingCandidates = candidatePaths.filter((path) => !retainedArchived.has(path));
    const metadata = await this.filterAndHydrateCandidates(pendingCandidates, options);

    const eventDirs = new Set<string>();
    for (const entry of metadata) {
      if (entry.relPath.startsWith('SavedClips/') || entry.relPath.startsWith('SentryClips/')) {
        const parentDir = this.parentDirectory(entry.relPath);
        if (parentDir) {
          eventDirs.add(parentDir);
        }
      }
    }

    const oldestAgeSec = metadata.length === 0
      ? 0
      : metadata.reduce((oldest, entry) => Math.max(oldest, entry.ageSec), 0);

    return {
      rootPath: options.rootPath,
      clips: metadata,
      filePaths: metadata.map((entry) => entry.relPath),
      pendingClips: {
        totalFiles: metadata.length,
        totalEvents: eventDirs.size,
        oldestAgeSec,
        files: metadata.map((entry) => ({
          relPath: entry.relPath,
          isSymlink: entry.isSymlink,
          ageSec: entry.ageSec,
        })),
      },
      candidatesDiscovered: candidatePaths.length,
      candidatesFiltered: pendingCandidates.length - metadata.length,
      previouslyArchivedRetained: retainedArchived.size,
    };
  }

  async markArchived(filePaths: string[], archivedListPath: string): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }

    const archivedSet = await this.readArchivedSet(archivedListPath);
    for (const filePath of filePaths) {
      archivedSet.add(filePath);
    }

    await this.writeArchivedSet(archivedListPath, archivedSet);
  }

  async resolveArchivedFromSource(rootPath: string, filePaths: string[]): Promise<string[]> {
    const archived: string[] = [];

    for (const relPath of filePaths) {
      const absPath = posixPath.join(rootPath, relPath);
      try {
        const stats = await lstat(absPath);
        if (!stats.isSymbolicLink()) {
          archived.push(relPath);
        }
      } catch {
        archived.push(relPath);
      }
    }

    return archived;
  }

  private async discoverCandidateSymlinks(options: ClipDiscoveryOptions): Promise<string[]> {
    const categoryConfigs: ClipCategoryConfig[] = [
      { directory: 'SavedClips', enabled: options.includeSavedclips ?? true },
      { directory: 'SentryClips', enabled: options.includeSentryclips ?? true },
      { directory: 'TeslaTrackMode', enabled: options.includeTrackmodeclips ?? true },
      { directory: 'RecentClips', enabled: options.includeRecentclips ?? false },
    ];

    const discovered = new Set<string>();

    for (const category of categoryConfigs) {
      if (!category.enabled) {
        continue;
      }

      const baseRelativePath = category.directory;
      const absolutePath = posixPath.join(options.rootPath, baseRelativePath);
      const paths = await this.walkClipEntries(absolutePath, baseRelativePath, options.includePredicate);
      for (const relPath of paths) {
        discovered.add(relPath);
      }
    }

    return Array.from(discovered).sort();
  }

  private async walkClipEntries(
    absoluteBasePath: string,
    baseRelativePath: string,
    includePredicate?: (relativePath: string) => boolean,
  ): Promise<string[]> {
    const result: string[] = [];

    const walk = async (absolutePath: string, relativePath: string): Promise<void> => {
      let dir;
      try {
        dir = await opendir(absolutePath);
      } catch {
        return;
      }

      for await (const entry of dir as AsyncIterable<Dirent>) {
        const entryAbsolutePath = posixPath.join(absolutePath, entry.name);
        const entryRelativePath = posixPath.join(relativePath, entry.name);

        if (entry.isDirectory()) {
          await walk(entryAbsolutePath, entryRelativePath);
          continue;
        }

        if (!entry.isSymbolicLink() && !entry.isFile()) {
          continue;
        }

        if (includePredicate && !includePredicate(entryRelativePath)) {
          continue;
        }

        result.push(entryRelativePath);
      }
    };

    await walk(absoluteBasePath, baseRelativePath);
    return result;
  }

  private async filterAndHydrateCandidates(
    filePaths: string[],
    options: ClipDiscoveryOptions,
  ): Promise<ClipMetadata[]> {
    const nowEpochSec = options.nowEpochSec ?? Math.floor(Date.now() / 1000);
    const minClipSizeBytes = options.minClipSizeBytes ?? DEFAULT_MIN_CLIP_SIZE_BYTES;
    const concurrency = Math.max(1, options.statConcurrency ?? DEFAULT_STAT_CONCURRENCY);

    const results: Array<ClipMetadata | null> = new Array(filePaths.length).fill(null);
    let nextIndex = 0;

    const evaluate = async (relPath: string): Promise<ClipMetadata | null> => {
      const absPath = posixPath.join(options.rootPath, relPath);

      let isSymlink = false;
      try {
        const linkStats = await lstat(absPath);
        isSymlink = linkStats.isSymbolicLink();
      } catch {
        return null;
      }

      let fileStats;
      try {
        fileStats = await stat(absPath);
      } catch {
        return null;
      }

      if (relPath.toLowerCase().endsWith('.mp4') && fileStats.size < minClipSizeBytes) {
        return null;
      }

      const ageSec = Math.max(0, nowEpochSec - Math.floor(fileStats.mtimeMs / 1000));
      return {
        key: `b2s:${blake2s256(relPath)}`,
        fileName: posixPath.basename(relPath),
        relPath,
        absPath,
        ageSec,
        isSymlink,
      };
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= filePaths.length) {
          return;
        }
        results[currentIndex] = await evaluate(filePaths[currentIndex]);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, filePaths.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return results.filter((entry): entry is ClipMetadata => entry !== null);
  }

  private async readArchivedSet(archivedListPath: string): Promise<Set<string>> {
    try {
      const content = await readFile(archivedListPath, 'utf-8');
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return new Set(lines);
    } catch {
      return new Set();
    }
  }

  private async writeArchivedSet(archivedListPath: string, archivedSet: Set<string>): Promise<void> {
    await mkdir(dirname(archivedListPath), { recursive: true });
    const lines = Array.from(archivedSet).sort();
    const payload = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await writeFile(archivedListPath, payload, 'utf-8');
  }

  private parentDirectory(path: string): string | null {
    const index = path.lastIndexOf('/');
    if (index <= 0) {
      return null;
    }
    return path.slice(0, index);
  }
}
