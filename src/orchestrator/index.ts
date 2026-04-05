/**
 * Legacy lineage:
 * - run/archiveloop (service entrypoint replacement)
 */
import { configLoader } from '../config';
import { logger, stateManager } from '../core';
import { gadgetManager } from '../core/gadget-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend, supportsTriggerFileWrites } from '../types';
import { ClipDiscoveryManager } from './clip-discovery-manager';
import { ClipDiscoveryLoop } from './clip-discovery-loop';
import { RsyncBackend } from './backends';
import { RuntimeLifecycleLoop } from './runtime-lifecycle-loop';
import { ArchiveEventBus, PushMessageEventHandler, TeslaApiInteropEventHandler } from './events';

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

/**
 * Builds legacy trigger file relative paths from configuration.
 */
function buildFinishTriggerFilePaths(config: ReturnType<typeof configLoader.get>): string[] {
  const triggerFilePaths: string[] = [];

  if (config.triggerFileSaved) {
    triggerFilePaths.push(`SavedClips/${config.triggerFileSaved}`);
  }
  if (config.triggerFileSentry) {
    triggerFilePaths.push(`SentryClips/${config.triggerFileSentry}`);
  }
  if (config.triggerFileRecent) {
    triggerFilePaths.push(`RecentClips/${config.triggerFileRecent}`);
  }
  if (config.triggerFileAny) {
    triggerFilePaths.push(config.triggerFileAny);
  }

  return triggerFilePaths;
}

/**
 * Builds optional archive-start trigger paths by suffixing finish trigger names.
 */
function buildStartTriggerFilePaths(finishTriggerFilePaths: string[]): string[] {
  return finishTriggerFilePaths.map((path) => `${path}.start`);
}

async function main(): Promise<void> {
  const config = configLoader.get();
  await gadgetManager.enable();
  logger.info('USB gadget enabled');
  const backend = createArchiveBackend(config);
  const finishTriggerFilePaths = buildFinishTriggerFilePaths(config);
  const startTriggerFilePaths = config.triggerFileStartEnabled
    ? buildStartTriggerFilePaths(finishTriggerFilePaths)
    : [];
  const eventBus = new ArchiveEventBus();
  const pushMessageEventHandler = new PushMessageEventHandler(config.notificationTitle);
  const teslaApiInteropEventHandler = new TeslaApiInteropEventHandler();
  eventBus.subscribe(async (event) => {
    await pushMessageEventHandler.handle(event);
  });
  eventBus.subscribe(async (event) => {
    await teslaApiInteropEventHandler.handle(event);
  });

  eventBus.subscribe(async (event) => {
    if (event.type !== 'archive-start' && event.type !== 'archive-finish') {
      return;
    }

    if (event.type === 'archive-finish' && !event.succeeded) {
      return;
    }

    const triggerPaths = event.triggerFilePaths ?? [];
    if (triggerPaths.length === 0) {
      return;
    }

    if (!supportsTriggerFileWrites(backend)) {
      return;
    }

    await backend.writeTriggerFiles(triggerPaths);
  });
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
      startTriggerFilePaths,
      finishTriggerFilePaths,
    },
    undefined,
    {
      eventBus,
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
