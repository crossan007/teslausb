/**
 * Legacy lineage:
 * - run/archiveloop (service entrypoint replacement)
 */
import { configLoader } from '../config';
import { logger, stateManager } from '../core';
import { concatMap } from 'rxjs';
import { Orchestrator } from './orchestrator';
import { ArchiveBackend } from '../types';
import { ClipDiscoveryManager } from './clip-discovery-manager';
import { ClipDiscoveryLoop } from './clip-discovery-loop';
import { RsyncBackend } from './backends';

const CLIP_DISCOVERY_ROOT = '/mutable/TeslaCam';
const ARCHIVED_LIST_PATH = '/mutable/sentry_files_archived';
const DISCOVERY_INTERVAL_MS = 5_000;

function createArchiveBackend(config: ReturnType<typeof configLoader.get>): ArchiveBackend {
  switch (config.archiveSystem) {
    case 'rsync':
      return new RsyncBackend({
        rsyncServer: config.rsyncServer,
        rsyncUser: config.rsyncUser,
        rsyncPath: config.rsyncPath,
      });
    case 'rclone':
    case 'cifs':
    case 'nfs':
    case 'none':
      throw new Error(`Archive backend '${config.archiveSystem}' is not implemented in TS orchestrator`);
    default:
      throw new Error(`Unsupported archive backend '${String(config.archiveSystem)}'`);
  }
}

async function main(): Promise<void> {
  const config = configLoader.get();
  const discovery = new ClipDiscoveryManager();
  const orchestrator = new Orchestrator(createArchiveBackend(config), undefined, undefined, stateManager);
  const discoveryLoop = new ClipDiscoveryLoop(discovery, {
    rootPath: CLIP_DISCOVERY_ROOT,
    archivedListPath: ARCHIVED_LIST_PATH,
    includeSavedclips: config.archiveSavedclips,
    includeSentryclips: config.archiveSentryclips,
    includeTrackmodeclips: config.archiveTrackmodeclips,
    includeRecentclips: config.archiveRecentclips,
    intervalMs: DISCOVERY_INTERVAL_MS,
    persistPendingClips: (pending) => stateManager.writePendingClips(pending),
  });

  discoveryLoop.discovered$
    .pipe(
      concatMap(async (discoveryResult) => {
        let result;
        let cycleError: unknown;

        try {
          result = await orchestrator.runArchiveCycle({
            fromPath: CLIP_DISCOVERY_ROOT,
            files: discoveryResult.filePaths,
          });
        } catch (error) {
          cycleError = error;
          logger.error({ error }, 'Archive cycle failed for discovery batch');
        }

        if (discoveryResult.filePaths.length > 0 && !result?.skipped) {
          const archivedNow = await discovery.resolveArchivedFromSource(CLIP_DISCOVERY_ROOT, discoveryResult.filePaths);
          if (archivedNow.length > 0) {
            await discovery.markArchived(archivedNow, ARCHIVED_LIST_PATH);
          }

          logger.info({ archivedMarked: archivedNow.length }, 'Verified archived files from source state');
        }

        if (cycleError) {
          return;
        }

        logger.info({ result, discovery: discoveryResult }, 'Archive cycle completed from discovery stream');
      }),
    )
    .subscribe({
      error: (error) => {
        logger.error({ error }, 'Discovery stream subscription failed');
      },
    });

  discoveryLoop.start();
  logger.info({ intervalMs: DISCOVERY_INTERVAL_MS }, 'Clip discovery loop started');

  await new Promise<void>(() => {
    // Keep service alive; discovery loop and subscriptions drive execution.
  });
}

main().catch((error) => {
  logger.error({ error }, 'Orchestrator entrypoint failed');
  process.exit(1);
});
