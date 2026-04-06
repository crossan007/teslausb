/**
 * Legacy lineage:
 * - run/archiveloop (service entrypoint replacement)
 */
import { TeslaUSBConfig } from '../../types';
import { logger, stateManager } from '../core';
import { gadgetManager } from '../core/gadget-manager';
import { ClipArchiveCoordinator } from './clip-archive-coordinator';
import { ArchiveBackend, supportsTriggerFileWrites } from '../../types';
import { ClipDiscoveryManager } from './clip-discovery-manager';
import { SnapshotDiscoveryConsumer } from './snapshot-discovery-consumer';
import { RsyncBackend } from './backends';
import { RuntimeLifecycleLoop } from './runtime-lifecycle-loop';
import { BackingImageChangeDetector } from './backing-image-change-detector';
import { SnapshotManager } from './snapshot-manager';
import { SnapshotEventCoordinator } from './snapshot-event-coordinator';
import { ArchiveEventBus, PushMessageEventHandler, TeslaApiInteropEventHandler } from './events';
import { ClipRegistryManager } from './clip-registry-manager';
import { TransferSession } from '../../types/transfer';

export interface OrchestratorContext {
  eventBus: ArchiveEventBus;
  snapshotManager: SnapshotManager;
}

const ARCHIVED_LIST_PATH = '/mutable/sentry_files_archived';
const CAM_DISK_PATH = '/backingfiles/cam_disk.bin';

function createArchiveBackend(config: TeslaUSBConfig): ArchiveBackend {
  switch (config.archiveSystem) {
    case 'rsync':
      return new RsyncBackend({
        rsyncServer: config.rsyncServer,
        rsyncUser: config.rsyncUser,
        rsyncPath: config.rsyncPath,
        rsyncMaxRate: config.rsyncMaxRate,
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
function buildFinishTriggerFilePaths(config: TeslaUSBConfig): string[] {
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

function recoverStaleTransferSessionAtStartup(): boolean {
  const session = stateManager.readTransferSession();
  if (!session) {
    return false;
  }

  const active =
    session.phase === 'starting' ||
    session.phase === 'transferring' ||
    session.phase === 'finalizing';

  if (!active) {
    return false;
  }

  const now = Date.now();
  const recoveredSession: TransferSession = {
    ...session,
    phase: 'failed',
    updatedAt: now,
    completedAt: session.completedAt ?? now,
  };

  stateManager.writeTransferSession(recoveredSession);
  logger.warn(
    {
      previousPhase: session.phase,
      sessionId: session.sessionId,
    },
    'Recovered stale active transfer session at startup',
  );

  return true;
}

export async function startOrchestrator(config: TeslaUSBConfig): Promise<OrchestratorContext> {
  const transferSessionRecovered = recoverStaleTransferSessionAtStartup();
  await gadgetManager.enable();
  logger.info('USB gadget enabled');
  const backend = createArchiveBackend(config);
  const finishTriggerFilePaths = buildFinishTriggerFilePaths(config);
  const startTriggerFilePaths = config.triggerFileStartEnabled
    ? buildStartTriggerFilePaths(finishTriggerFilePaths)
    : [];
  const eventBus = new ArchiveEventBus();
  eventBus.subscribe(async (event) => {
    logger.debug({ event }, 'Event received by main event bus');
  });
  const snapshotManager = new SnapshotManager();
  await snapshotManager.cleanupStaleSnapshots();
  const snapshotEventCoordinator = new SnapshotEventCoordinator({
    eventBus,
    snapshotManager
  });
  const backingImageChangeDetector = new BackingImageChangeDetector({
    imagePath: CAM_DISK_PATH,
    eventBus,
    emitInitialEvent: true,
  });
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
  const clipRegistryManager = new ClipRegistryManager({
    initialRegistry: stateManager.readClipRegistry() ?? undefined,
    persistRegistry: (registry) => stateManager.writeClipRegistry(registry),
  });
  stateManager.writeStartupRecoveryStatus({
    updatedAt: Date.now(),
    transferSessionRecovered,
    clipRegistryRecoveredTransferring: clipRegistryManager.startupRecoveredTransferringCount(),
  });
  const discoveryConsumer = new SnapshotDiscoveryConsumer(discovery, {
    archivedListPath: ARCHIVED_LIST_PATH,
    includeSavedclips: config.archiveSavedclips,
    includeSentryclips: config.archiveSentryclips,
    includeTrackmodeclips: config.archiveTrackmodeclips,
    includeRecentclips: config.archiveRecentclips,
    eventBus,
    persistPendingClips: (pending) => stateManager.writePendingClips(pending),
  });
  const lifecycleLoop = new RuntimeLifecycleLoop(
    discoveryConsumer,
    discovery,
    clipArchiveCoordinator,
    backend,
    {
      archivedListPath: ARCHIVED_LIST_PATH,
      archiveDelaySec: config.archiveDelay,
      startTriggerFilePaths,
      finishTriggerFilePaths,
    },
    undefined,
    {
      eventBus,
      clipRegistryManager,
    },
  );

  snapshotEventCoordinator.start();
  backingImageChangeDetector.start();
  lifecycleLoop.start();
  logger.info('Clip discovery loop started');

  return { eventBus, snapshotManager };
}
