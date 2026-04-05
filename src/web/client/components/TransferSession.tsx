import React, { useMemo } from 'react';
import { useApi } from '../hooks';
import { TransferSessionView } from '../../view-services/types';

interface Props {
  wsMessage?: any;
}

export default function TransferSessionComponent({ wsMessage }: Props) {
  const { data: restData } = useApi<TransferSessionView>(
    '/api/transfer-session',
    { interval: 2000 },
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

  let startedTime = '';
  if (session.startedAtEpoch && session.isActive) {
    const elapsed = Math.floor((Date.now() / 1000) - session.startedAtEpoch);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    startedTime = ` - Elapsed: ${minutes}m ${seconds}s`;
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
          <span className="session-time">{startedTime}</span>
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
