import React, { useMemo } from 'react';
import { useApi } from '../hooks';
import { SnapshotView } from '../../view-services/types';

interface Props {
  wsMessage?: any;
}

export default function SnapshotsComponent({ wsMessage }: Props) {
  const { data: restData } = useApi<SnapshotView[]>(
    '/api/snapshots',
    { interval: 3000 },
  );

  // Prefer WebSocket data if available
  const snapshots = useMemo(() => {
    if (
      wsMessage?.type === 'snapshots-update' &&
      Array.isArray(wsMessage?.data)
    ) {
      return wsMessage.data as SnapshotView[];
    }
    return restData ?? [];
  }, [wsMessage, restData]);

  if (!snapshots || snapshots.length === 0) {
    return (
      <div className="panel snapshots">
        <h2>Snapshots</h2>
        <p>No active snapshots</p>
      </div>
    );
  }

  return (
    <div className="panel snapshots">
      <h2>Snapshots ({snapshots.length})</h2>

      <div className="snapshots-list">
        {snapshots.map((snap) => (
          <div key={snap.snapshot.id} className="snapshot-item">
            <div className="snapshot-header">
              <h3>{snap.snapshot.id}</h3>
              <small>
                {new Date(snap.snapshot.createdAt * 1000).toLocaleTimeString()}
              </small>
            </div>

            <div className="snapshot-stats">
              <span className="file-count">
                📁 {snap.newFilesCount} new files
              </span>
            </div>

            {snap.filesInProgress.length > 0 && (
              <div className="files-list">
                <small>Files {snap.filesInProgress.length}</small>
                <ul>
                  {snap.filesInProgress.slice(0, 5).map((file) => (
                    <li key={file.relPath} className={`file-item status-${file.status}`}>
                      <span className="file-path">{file.relPath}</span>
                      <span className="file-status">
                        {file.status === 'archived' && '✓'}
                        {file.status === 'transferred' && '🔄'}
                        {file.status === 'pending' && '⏳'}
                        {file.status === 'failed' && '✗'}
                      </span>
                      {file.progressPercent !== undefined && (
                        <span className="file-progress">
                          {file.progressPercent}%
                        </span>
                      )}
                    </li>
                  ))}
                  {snap.filesInProgress.length > 5 && (
                    <li className="more-files">
                      +{snap.filesInProgress.length - 5} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
