# TeslaUSB Web UI Architecture

## Overview

The web UI consists of three independent layers that communicate via a clean separation of concerns:

1. **View Services Layer** (`src/web/view-services/`)
   - Database-agnostic query and subscription interfaces
   - No HTTP or WebSocket dependencies
   - Subscribable streams for real-time updates
   - Examples: `SystemStatusView`, `TransferSessionViewService`, `SnapshotListViewService`

2. **Web Server** (`src/web/server/`)
   - Express REST API server
   - WebSocket server for push updates
   - Both consume the same view services
   - Configurable CORS for cross-origin development

3. **React Client** (`src/web/client/`)
   - Single Page Application (SPA)
   - Fallback REST polling with WebSocket push
   - Environment-based backend URL configuration
   - Component-based UI with real-time updates

## Dual Protocol Communication

The architecture enables both REST and WebSocket without code duplication:

```
┌─────────────────────────────────────┐
│   Orchestrator (event bus + state)  │
└────────────┬────────────────────────┘
             │
        ┌────▼─────────────────────────────┐
        │   View Services (shared logic)   │
        │ - getCurrentTransfer()            │
        │ - getSnapshots()                  │
        │ - getSystemStatus()               │
        └────┬────────────────┬────────────┘
             │                │
        ┌────▼─────┐    ┌─────▼──────┐
        │ REST API  │    │ WebSocket  │
        │ /api/*    │    │ /subscribe │
        └─────┬─────┘    └────┬───────┘
              │                │
              └────────┬───────┘
                       │
                 ┌─────▼──────┐
                 │ React SPA  │
                 └────────────┘
```

### Benefits

- **Single source of truth**: Business logic in view services only
- **No duplication**: REST and WebSocket share the same data
- **Flexible deployment**: Client can run on different machine
- **Progressive enhancement**: Works over REST polling, enhanced with WebSocket
- **Easy to test**: View services can be tested independently

## Environment Configuration

### Backend (`src/`)

Set these environment variables to customize system-level features:

```bash
# Network health check configuration
SYSTEM_STATUS_DEFAULT_GATEWAY=192.168.1.1
SYSTEM_STATUS_PING_PACKET_SIZE=1024

# UI CORS configuration
UI_CORS_ORIGINS=*  # Or: http://localhost:3001,https://dashboard.example.com
```

### Frontend (`src/web/client/`)

Set these environment variables to configure which backend to connect to:

```bash
# Development: Connect to local backend
REACT_APP_API_BASE_URL=http://localhost:3000
REACT_APP_WS_URL=ws://localhost:3000

# Remote development: Connect to Pi backend
REACT_APP_API_BASE_URL=http://192.168.1.100:3000
REACT_APP_WS_URL=ws://192.168.1.100:3000
```

Or the backend can tell the client its URL via `/api/config`:

```json
{
  "apiBaseUrl": "http://192.168.1.100:3000",
  "wsUrl": "ws://192.168.1.100:3000"
}
```

## API Endpoints

### Health & Config

- `GET /api/health` - Health check
- `GET /api/config` - Get backend URL configuration for client

### System Status

- `GET /api/system-status` - Current system health metrics
  ```json
  {
    "uptime": 3600,
    "cpuTempC": 45.5,
    "drivesActive": true,
    "totalSpace": 1099511627776,
    "freeSpace": 549755813888,
    "numSnapshots": 3,
    "pingTimeMs": 2.5,
    "packetLoss": 0
  }
  ```

### Transfer Session

- `GET /api/transfer-session` - Current transfer session status
  ```json
  {
    "isActive": true,
    "startedAtEpoch": 1712325600,
    "totalFilesInBatch": 150,
    "filesCompleted": 45,
    "filesFailed": 0,
    "overallProgressPercent": 30,
    "currentFile": {
      "relPath": "SavedClips/2026-04-05_12-34/video.mp4",
      "status": "transferring",
      "progressPercent": 65,
      "transferredBytes": 1073741824,
      "totalBytes": 1649267441
    }
  }
  ```

- `GET /api/transfer-session/files` - All files in current batch

### Snapshots

- `GET /api/snapshots` - List of active snapshots
  ```json
  [
    {
      "id": "snap-000001",
      "createdAtEpoch": 1712325600,
      "newFilesAddedCount": 150,
      "filesInArchiveSession": [...]
    }
  ]
  ```

## WebSocket Events

Connect to `/ws` endpoint. Server pushes updates:

- `transfer-session-update` - Current session state changed
- `snapshots-update` - Snapshot list changed
- `system-status-update` - System status changed (periodic, ~5 sec)

Example message:

```json
{
  "type": "transfer-session-update",
  "data": {
    "isActive": true,
    "overallProgressPercent": 30,
    "filesCompleted": 45
  }
}
```

## Development

### Running Backend & Frontend Together

```bash
# Terminal 1: Start backend (includes WebSocket + REST API)
npm run start:orchestrator

# Terminal 2: Start React frontend dev server
cd src/web/client
npm run start
```

### Running Frontend on Different Machine

```bash
# On development machine
export REACT_APP_API_BASE_URL=http://192.168.1.100:3000
export REACT_APP_WS_URL=ws://192.168.1.100:3000
npm run start

# Backend on Pi will automatically enable CORS for you
```

## Integration with Orchestrator

To wire the web server into the orchestrator:

```typescript
import { WebServerIntegration } from './src/web/server';

// In orchestrator main()
const webServer = new WebServerIntegration(
  eventBus,
  systemStatusManager,
  clipArchiveCoordinator,
  snapshotManager,
);

await webServer.start();

// Connect lifecycle loop to push updates
lifecycleLoop.onDiscoveryResult((result) => {
  webServer.updateDiscoveryResult(result);
});
```

## Future Enhancements

- [ ] Authentication/JWT for remote access
- [ ] Historical transfer statistics
- [ ] Alert/notification system
- [ ] Mobile-responsive PWA
- [ ] Drive health monitoring (S.M.A.R.T. data)
- [ ] Advanced filtering and search
