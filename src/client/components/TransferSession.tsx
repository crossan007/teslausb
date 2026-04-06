import React, { useMemo } from 'react';
import { useApi } from '../hooks';
import { TransferSessionView } from '../../view-services/types';

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

export default function TransferSessionComponent({ wsMessage, wsConnected }: Props) {
  const { data: restData } = useApi<TransferSessionView>(
    '/api/transfer-session',
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

  if (!session) {
    return (
      <div className="panel transfer-session">
        <h2>Transfer Session</h2>
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
      <h2>Transfer Session</h2>

      <div className="session-header">
        <div className="session-status">
          <strong>
            {session.isActive ? '🔄 Transferring' : '⏸️ Idle'}
          </strong>
          {(elapsedText || countdownText) && (
            <span className="session-time">
              {[elapsedText, countdownText].filter(Boolean).join(' • ')}
            </span>
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
