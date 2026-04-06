import React, { useMemo } from 'react';
import { useApi } from '../hooks';
import { SnapshotView, TransferSessionView } from '../../view-services/types';

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
    return 'To do';
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

  const { data: snapshotsRestData } = useApi<SnapshotView[]>(
    '/api/snapshots',
    {
      interval: 5000,
      enabled: !wsConnected,
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

  const snapshots = useMemo(() => {
    if (
      wsMessage?.type === 'snapshots-update' &&
      Array.isArray(wsMessage?.data)
    ) {
      return wsMessage.data as SnapshotView[];
    }

    return snapshotsRestData ?? [];
  }, [wsMessage, snapshotsRestData]);

  if (!session) {
    return (
      <div className="panel transfer-session">
        <h2>Transfer Session</h2>
        <p>Idle</p>
      </div>
    );
  }

  const sessionFiles = useMemo(() => {
    const deduped = new Map<string, SnapshotView['filesInProgress'][number]>();

    snapshots.forEach((snapshot) => {
      snapshot.filesInProgress.forEach((file) => {
        if (!deduped.has(file.relPath)) {
          deduped.set(file.relPath, file);
        }
      });
    });

    if (session.currentFile && !deduped.has(session.currentFile.relPath)) {
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
  }, [snapshots, session.currentFile]);

  const activeFiles = sessionFiles.filter((file) => file.status === 'transferring');

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

  const progressBar = (
    <div className="progress-bar">
      <div
        className="progress-fill"
        style={{
          width: `${session.overallProgressPercent}%`,
        }}
      >
        {session.overallProgressPercent > 5 && (
          <span className="progress-text">
            {session.overallProgressPercent}%
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="panel transfer-session">
      <div className="transfer-header">
        <h2>Transfer Session</h2>
        <div className="transfer-header-status">
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
        <label>Actively Transferring</label>
        {activeFiles.length === 0 ? (
          <p className="session-empty">No files are actively transferring.</p>
        ) : (
          <ul className="active-files-list">
            {activeFiles.map((file) => (
              <li key={file.relPath} className="active-file-item">
                <div className="active-file-row">
                  <span className="active-file-status">↻ Transferring</span>
                  <span className="active-file-name">{file.relPath}</span>
                  {file.progressPercent !== undefined && (
                    <span className="active-file-progress">{file.progressPercent}%</span>
                  )}
                </div>
                {file.progressPercent !== undefined && (
                  <div className="progress-bar small">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, file.progressPercent))}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="session-file-window">
          <div className="session-file-window-title">All Session Files</div>
          {sessionFiles.length === 0 ? (
            <p className="session-empty">No session files found yet.</p>
          ) : (
            <ul className="session-file-table" role="list">
              {sessionFiles.map((file) => (
                <li key={file.relPath} className={`session-file-row status-${file.status}`}>
                  <span className="session-file-state">{statusMark(file.status)} {statusLabel(file.status)}</span>
                  <span className="session-file-path">{file.relPath}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {session.isActive && (
        <div className="session-stats">
          <div className="stat-row">
            <label>Files</label>
            <value>
              {session.filesCompleted} / {session.totalFilesInBatch} complete
              {session.filesFailed > 0 && (
                <span className="failed">
                  , {session.filesFailed} failed
                </span>
              )}
            </value>
          </div>

          <div className="stat-row">
            <label>Overall Progress</label>
            {progressBar}
          </div>

          {session.currentFile && (
            <div className="current-file">
              <label>Current File</label>
              <p>{session.currentFile.relPath}</p>
              {session.currentFile.totalBytes && (
                <>
                  <small>
                    {(
                      (session.currentFile.transferredBytes ?? 0) /
                      (1024 ** 2)
                    ).toFixed(1)}
                    MB / {(session.currentFile.totalBytes / (1024 ** 2)).toFixed(1)}
                    MB
                  </small>
                  {session.currentFile.progressPercent !== undefined && (
                    <div className="progress-bar small">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${session.currentFile.progressPercent}%`,
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
