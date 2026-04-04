/**
 * Legacy lineage:
 * - run/archiveloop (service entrypoint replacement)
 */
import { configLoader } from '../config';
import { logger, stateManager } from '../core';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend } from '../types';
import { ClipDiscoveryManager } from './clip-discovery-manager';
import { ClipDiscoveryLoop } from './clip-discovery-loop';
import { RsyncBackend } from './backends';
import { RuntimeLifecycleLoop } from './runtime-lifecycle-loop';

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
  const backend = createArchiveBackend(config);
  const discovery = new ClipDiscoveryManager();
  const clipArchiveCoordinator = new ClipArchiveCoordinator(backend, undefined, undefined, stateManager);
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
  const lifecycleLoop = new RuntimeLifecycleLoop(
    discoveryLoop,
    discovery,
    clipArchiveCoordinator,
    backend,
    {
      clipDiscoveryRoot: CLIP_DISCOVERY_ROOT,
      archivedListPath: ARCHIVED_LIST_PATH,
      archiveDelaySec: config.archiveDelay,
    },
  );

  lifecycleLoop.start();
  logger.info({ intervalMs: DISCOVERY_INTERVAL_MS }, 'Clip discovery loop started');

  await new Promise<void>(() => {
    // Keep service alive; discovery loop and subscriptions drive execution.
  });
}

main().catch((error) => {
  logger.error({ error }, 'Orchestrator entrypoint failed');
  process.exit(1);
});
