import React, { useMemo } from 'react';
import { useApi } from '../hooks';
import {
  FileTransferProgress,
  TransferSessionView,
} from '../../view-services/types';

interface Props {
  wsMessage?: any;
  wsConnected: boolean;
}

function normalizeEpochSeconds(epoch?: number): number | undefined {
  if (epoch === undefined || !Number.isFinite(epoch) || epoch <= 0) {
    return undefined;
  }

  if (epoch > 1e12) {
    return Math.floor(epoch / 1000);
  }

  return Math.floor(epoch);
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function statusLabel(status: 'pending' | 'transferring' | 'archived' | 'failed'): string {
  if (status === 'pending') {
    return 'Queued';
  }
  if (status === 'transferring') {
    return 'Transferring';
  }
  if (status === 'archived') {
    return 'Done';
  }
  return 'Failed';
}

function statusMark(status: 'pending' | 'transferring' | 'archived' | 'failed'): string {
  if (status === 'pending') {
    return '○';
  }
  if (status === 'transferring') {
    return '↻';
  }
  if (status === 'archived') {
    return '✓';
  }
  return '!';
}

function statusRank(status: 'pending' | 'transferring' | 'archived' | 'failed'): number {
  if (status === 'transferring') {
    return 0;
  }
  if (status === 'pending') {
    return 1;
  }
  if (status === 'failed') {
    return 2;
  }
  return 3;
}

export default function TransferSessionComponent({ wsMessage, wsConnected }: Props) {
  const { data: restData } = useApi<TransferSessionView>(
    '/api/transfer-session',
    {
      interval: 5000,
      enabled: !wsConnected,
    },
  );

  const { data: queueRestData } = useApi<FileTransferProgress[]>(
    '/api/transfer-queue',
    {
      interval: 5000,
    },
  );

  const { data: sessionFilesRestData } = useApi<FileTransferProgress[]>(
    '/api/transfer-session/files',
    {
      interval: 5000,
    },
  );

  // Prefer WebSocket data if available
  const session = useMemo(() => {
    if (
      wsMessage?.type === 'transfer-session-update' &&
      wsMessage?.data
    ) {
      return wsMessage.data as TransferSessionView;
    }
    return restData;
  }, [wsMessage, restData]);

  const transferFiles = useMemo(() => {
    if (
      wsMessage?.type === 'transfer-queue-update' &&
      Array.isArray(wsMessage?.data)
    ) {
      return wsMessage.data as FileTransferProgress[];
    }

    return queueRestData ?? sessionFilesRestData ?? [];
  }, [wsMessage, queueRestData, sessionFilesRestData]);

  const allQueueFiles = useMemo(() => {
    const deduped = new Map<string, FileTransferProgress>();
    for (const file of transferFiles) {
      deduped.set(file.relPath, file);
    }

    if (session?.currentFile && !deduped.has(session.currentFile.relPath)) {
      deduped.set(session.currentFile.relPath, session.currentFile);
    }

    return Array.from(deduped.values())
      .sort((left, right) => {
        const rankDiff = statusRank(left.status) - statusRank(right.status);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        return left.relPath.localeCompare(right.relPath);
      });
  }, [transferFiles, session]);

  const activeFile =
    allQueueFiles.find((file) => file.status === 'transferring') ??
    session?.currentFile;

  const queuedFiles = allQueueFiles.filter((file) => file.status === 'pending');
  const queueDepth = queuedFiles.length;

  if (!session) {
    return (
      <div className="panel transfer-session">
        <h2>Transfer Queue</h2>
        <p>Idle</p>
      </div>
    );
  }

  let elapsedText: string | undefined;
  let countdownText: string | undefined;

  if (session.startedAtEpoch && session.isActive) {
    const startedAtSeconds = normalizeEpochSeconds(session.startedAtEpoch);
    if (startedAtSeconds !== undefined) {
      const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000) - startedAtSeconds);
      elapsedText = `Elapsed: ${formatDuration(elapsedSeconds)}`;
    }
  }

  if (session.remainingSeconds !== undefined && Number.isFinite(session.remainingSeconds)) {
    const safeRemaining = Math.max(0, Math.floor(session.remainingSeconds));
    countdownText = `Remaining: ${formatDuration(safeRemaining)}`;
  }

  return (
    <div className="panel transfer-session">
      <div className="transfer-header">
        <h2>Transfer Queue</h2>
        <div className="transfer-header-status">
          <span className="queue-depth">Depth: {queueDepth}</span>
          <strong className={session.isActive ? 'status-active' : 'status-idle'}>
            {session.isActive ? '🔄 Transferring' : '⏸️ Idle'}
          </strong>
          <span>
            {session.filesCompleted}/{session.totalFilesInBatch} done
            {session.filesFailed > 0 ? `, ${session.filesFailed} failed` : ''}
          </span>
          {(elapsedText || countdownText) && (
            <span className="session-time">
              {[elapsedText, countdownText].filter(Boolean).join(' • ')}
            </span>
          )}
        </div>
      </div>

      <div className="session-active-files">
        <label>Current Transfer</label>
        {!activeFile ? (
          <p className="session-empty">No files are actively transferring.</p>
        ) : (
          <div className="active-file-item">
            <div className="active-file-row">
              <span className="active-file-status">↻ {statusLabel(activeFile.status)}</span>
              <span className="active-file-name">{activeFile.relPath}</span>
              {activeFile.progressPercent !== undefined && (
                <span className="active-file-progress">{activeFile.progressPercent}%</span>
              )}
            </div>
            <div className="active-file-meta">
              <span>Age: {Math.floor(activeFile.ageSec / 60)}m</span>
              <span>{activeFile.isSymlink ? 'Symlink' : 'Materialized'}</span>
              {activeFile.totalBytes !== undefined && (
                <span>
                  {(((activeFile.transferredBytes ?? 0) / (1024 ** 2))).toFixed(1)}MB / {((activeFile.totalBytes / (1024 ** 2))).toFixed(1)}MB
                </span>
              )}
            </div>
            {activeFile.progressPercent !== undefined && (
              <div className="progress-bar small">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.max(0, Math.min(100, activeFile.progressPercent))}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="session-file-window">
          <div className="session-file-window-title">Queued Files</div>
          {queuedFiles.length === 0 ? (
            <p className="session-empty">Queue is empty.</p>
          ) : (
            <ul className="session-file-table" role="list">
              {queuedFiles.map((file) => (
                <li key={file.relPath} className={`session-file-row status-${file.status}`}>
                  <span className="session-file-state">{statusMark(file.status)} {statusLabel(file.status)}</span>
                  <span className="session-file-path">{file.relPath}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

    </div>
  );
}
