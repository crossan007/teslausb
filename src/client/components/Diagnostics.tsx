import React, { useState } from 'react';
import { useApi } from '../hooks';

type StatusCounts = {
  pending: number;
  transferring: number;
  failed: number;
  transferred: number;
};

type SnapshotSummary = {
  snapshotId: string;
  totalEntries: number;
  unresolvedCount?: number;
  statusCounts: StatusCounts;
  oldestFirstSeenAt: number;
  newestUpdatedAt: number;
};

type DebugEntrySample = {
  key: string;
  relPath: string;
  status: 'pending' | 'transferring' | 'failed' | 'transferred';
  firstSeenSnapshotId: string;
  preferredSnapshotId: string;
  firstSeenAt: number;
  updatedAt: number;
  ageSec: number;
};

type DebugPayload = {
  generatedAt: number;
  summary: {
    totalEntries: number;
    statusCounts: StatusCounts;
    distinctFirstSeenSnapshots: number;
    distinctPreferredSnapshots: number;
    queueDepth: number;
  };
  snapshots: {
    firstSeen: SnapshotSummary[];
    preferred: SnapshotSummary[];
  };
  runtime: {
    activeSnapshot: {
      id: string;
      createdAt: number;
      mountPath: string;
      isLinked: boolean;
    } | null;
    pendingClips: {
      totalFiles: number;
      totalEvents: number;
      oldestAgeSec: number;
    } | null;
    transferSession: {
      sessionId: string;
      phase: string;
      filesTotal: number;
      filesCompleted: number;
      filesFailed: number;
      currentFilePath?: string;
      updatedAt: number;
    } | null;
  };
  alerts: Array<{
    level: 'info' | 'warning';
    code: string;
    message: string;
  }>;
  recentSamples: {
    byFirstSeenAtDesc: DebugEntrySample[];
    byUpdatedAtDesc: DebugEntrySample[];
  };
};

function formatTs(ts: number): string {
  if (!ts || !Number.isFinite(ts)) {
    return '-';
  }

  const millis = ts > 1e12 ? ts : ts * 1000;
  return new Date(millis).toLocaleTimeString();
}

function topRows(rows: SnapshotSummary[], max = 6): SnapshotSummary[] {
  return rows.slice(0, max);
}

export default function DiagnosticsComponent() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const { data, loading, error } = useApi<DebugPayload>('/api/debug/clip-registry?limit=20', {
    interval: 5000,
  });

  async function copyTextWithFallback(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall back to execCommand below.
      }
    }

    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.opacity = '0';

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, textArea.value.length);

      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);
      return copied;
    } catch {
      return false;
    }
  }

  async function copyPayload(): Promise<void> {
    if (!data) {
      return;
    }

    const payload = JSON.stringify(data, null, 2);
    const copied = await copyTextWithFallback(payload);

    if (copied) {
      setCopyState('copied');
    } else {
      setCopyState('error');
    }

    window.setTimeout(() => {
      setCopyState('idle');
    }, 1800);
  }

  if (loading && !data) {
    return (
      <div className="panel diagnostics">
        <h2>Diagnostics</h2>
        <p>Loading diagnostics...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="panel diagnostics">
        <h2>Diagnostics</h2>
        <p className="diag-error">Failed to load diagnostics: {error.message}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel diagnostics">
        <h2>Diagnostics</h2>
        <p>No diagnostics available</p>
      </div>
    );
  }

  const firstSeenRows = topRows(data.snapshots.firstSeen);
  const preferredRows = topRows(data.snapshots.preferred);
  const recentRows = data.recentSamples.byFirstSeenAtDesc.slice(0, 8);

  return (
    <div className="panel diagnostics">
      <div className="diag-title-row">
        <h2>Diagnostics</h2>
        <button type="button" className="diag-copy-btn" onClick={copyPayload}>
          Copy JSON
        </button>
      </div>

      <div className="diag-meta">Generated {formatTs(data.generatedAt)}</div>
      {copyState === 'copied' && <div className="diag-copy-feedback">Copied diagnostics JSON.</div>}
      {copyState === 'error' && <div className="diag-copy-feedback error">Copy failed (clipboard blocked by browser).</div>}

      <div className="diag-stats-grid">
        <div className="diag-stat">
          <label>Registry Entries</label>
          <strong>{data.summary.totalEntries}</strong>
        </div>
        <div className="diag-stat">
          <label>Queue Depth</label>
          <strong>{data.summary.queueDepth}</strong>
        </div>
        <div className="diag-stat">
          <label>Pending / Xfer / Failed</label>
          <strong>
            {data.summary.statusCounts.pending} / {data.summary.statusCounts.transferring} / {data.summary.statusCounts.failed}
          </strong>
        </div>
        <div className="diag-stat">
          <label>Transferred</label>
          <strong>{data.summary.statusCounts.transferred}</strong>
        </div>
      </div>

      <div className="diag-section">
        <h3>Anomalies</h3>
        {data.alerts.length === 0 ? (
          <p className="diag-empty">No active anomalies.</p>
        ) : (
          <ul className="diag-alert-list">
            {data.alerts.map((alert) => (
              <li key={alert.code} className={`diag-alert ${alert.level}`}>
                <span className="diag-alert-level">{alert.level.toUpperCase()}</span>
                <span>{alert.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="diag-section">
        <h3>Active Snapshot</h3>
        {!data.runtime.activeSnapshot ? (
          <p className="diag-empty">No active snapshot.</p>
        ) : (
          <div className="diag-runtime-row">
            <span>{data.runtime.activeSnapshot.id}</span>
            <span>Created: {formatTs(data.runtime.activeSnapshot.createdAt)}</span>
            <span>{data.runtime.activeSnapshot.isLinked ? 'Mounted' : 'Not mounted'}</span>
          </div>
        )}
      </div>

      <div className="diag-section">
        <h3>First-Seen by Snapshot</h3>
        <ul className="diag-rows">
          {firstSeenRows.map((row) => (
            <li key={`fs-${row.snapshotId}`}>
              <span>{row.snapshotId}</span>
              <span>Total: {row.totalEntries}</span>
              <span>Unresolved: {row.unresolvedCount ?? 0}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="diag-section">
        <h3>Preferred by Snapshot</h3>
        <ul className="diag-rows">
          {preferredRows.map((row) => (
            <li key={`pref-${row.snapshotId}`}>
              <span>{row.snapshotId}</span>
              <span>Total: {row.totalEntries}</span>
              <span>Failed: {row.statusCounts.failed}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="diag-section">
        <h3>Recent First-Seen Samples</h3>
        <ul className="diag-samples">
          {recentRows.map((row) => (
            <li key={`sample-${row.key}`}>
              <span className={`diag-status status-${row.status}`}>{row.status}</span>
              <span className="diag-path">{row.relPath}</span>
              <span>{row.firstSeenSnapshotId}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
