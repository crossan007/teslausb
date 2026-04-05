# TeslaUSB Architecture Guide

This guide is for contributors who want to quickly answer:

- **How does TeslaUSB work end-to-end?**
- **Where should I edit for a specific behavior?**
- **What are the extension points and safe change boundaries?**

---

## 1) Mental model (in one minute)

TeslaUSB is an embedded system that turns a Raspberry Pi/SBC into a USB drive for Tesla, while also:

- continuously snapshotting and cleaning the camera filesystem,
- archiving clips when home network storage is reachable,
- exposing recordings and diagnostics via nginx/web UI.

The architecture has 4 layers:

1. **Provisioning layer** (`setup/pi/*`): validates config, installs scripts, configures OS services.
2. **Runtime orchestrator** (`src/orchestrator/*` via `teslausb-node.service`): the long-running TypeScript control loop.
3. **Archive backend layer** (`src/orchestrator/backends/rsync-backend.ts`): current runtime support is `ARCHIVE_SYSTEM=rsync`.
4. **Web and mount layer** (`teslausb-www/*`, `run/auto.*`, snapshot scripts): browsing/download UX and autofs mounts.

---

## 2) End-to-end lifecycle

### Install / upgrade lifecycle

- Main installer entrypoint: `setup/pi/setup-teslausb`
- Reads user config via: `setup/pi/envsetup.sh` (`/root/teslausb_setup_variables.conf`)
- Runs configuration pipeline in: `setup/pi/configure.sh`
- Picks archive module with `get_archive_module()` and installs module scripts to `/root/bin`
- Writes and enables systemd unit `teslausb-node.service` that runs the TypeScript orchestrator runtime

#### Upgrade prerequisite on legacy 2G root layouts

For older installs where `/` is 2G and nearly full, `setup-teslausb upgrade` can fail while installing Node runtime and dependencies.

Required migration policy:

1. Keep root partition large enough for Node runtime and app payload.
2. If root is too full to complete upgrade, either:
  - clean obsolete runtime artifacts from `/` before rerunning upgrade, or
  - perform a destructive repartition to increase root (delete/recreate `/backingfiles` and `/mutable`).
3. Treat this as an upgrade precheck for v2 runtime roll-forward.

Operator helper command:

- `setup-teslausb expand_root <new_root_size>` automates destructive root expansion for legacy cramped layouts.
- This command deletes `/backingfiles` and `/mutable` partitions and therefore deletes recordings/snapshots/state.
- The command now recreates temporary fallback `/mutable` and `/backingfiles` directories on root so the device can reboot and complete `setup-teslausb upgrade`.
- After running it, reboot and run `setup-teslausb upgrade` to recreate partitions and continue rollout.

### Runtime lifecycle (service)

- Service unit: `teslausb-node.service`
- Service entrypoint: `src/orchestrator/index.ts` (Node runtime)
- Boot sequence (simplified):
  1. load env (`/root/bin/envsetup.sh`)
  2. start helpers (temperature monitor, snapshot loop, free-space manager, wifi checker, log rotator)
  3. fsck + clean mounts + initial snapshot
  4. expose USB gadget to Tesla
  5. when archive destination is reachable: connect archive, archive clips, optional music sync, disconnect
  6. loop forever waiting for archive reachable/unreachable transitions

### Web lifecycle

- Web stack configured by: `setup/pi/configure-web.sh`
- nginx site config source: `teslausb-www/teslausb.nginx`
- Static/CGI assets source: `teslausb-www/html/`
- New UI bundle pulled during setup from external `teslausb-webui` release tarball
- Snapshot/music browsing mounts provided by autofs maps: `run/auto.teslausb`, `run/auto.www`

---

## 3) Directory map by responsibility

## Top-level folders

- `setup/`: installation, reconfiguration, distro-level changes
- `run/`: runtime scripts executed on device (`/root/bin` after install)
- `teslausb-www/`: nginx config, static web assets, FUSE helper source
- `tests/`: shell tests for backingfile creation logic
- `tools/`: image/build/maintenance helper scripts
- `pi-gen-sources/`: Raspberry Pi image customization sources
- `doc/`: setup/how-to docs for users

## Runtime scripts (`run/`) highlights

These are primarily legacy shell helpers that are still used where not yet migrated to TypeScript.

- `archiveloop`: **legacy core orchestrator** (replaced by `src/orchestrator/*` in current TS runtime path)
- `make_snapshot.sh` / `release_snapshot.sh`: snapshot creation & retention mechanics
- `manage_free_space.sh`: camera disk space pressure handling
- `enable_gadget.sh` / `disable_gadget.sh`: USB gadget attach/detach
- `waitforidle`: car-idle gating before writes
- `send-push-message`: fan-out notification dispatcher
- `temperature_monitor`: periodic thermal checks/notifications

## Archive backend modules

Current TS runtime support is `rsync` only. The additional backend directories below remain legacy implementation paths.

Each backend directory (`run/rsync_archive`, `run/cifs_archive`, `run/nfs_archive`, `run/rclone_archive`, `run/none_archive`) provides a legacy contract consumed by `archiveloop`:

- `verify-and-configure-archive.sh`
- `archive-is-reachable.sh`
- `connect-archive.sh`
- `archive-clips.sh`
- `disconnect-archive.sh`
- optional `copy-music.sh` (for cifs/nfs music share paths)

---

## 4) Where to jump in (by change goal)

### “I want to change archive behavior (what gets copied / how retries work)”

Start here:

- `src/orchestrator/runtime-lifecycle-loop.ts` (file list generation, retry/connect loop)
- `src/orchestrator/backends/rsync-backend.ts` (current backend transfer implementation)

Good to also inspect:

- `src/orchestrator/backends/command-runner.ts`
- `src/orchestrator/backends/index.ts`

### “I want to add or modify an archive backend”

Start here:

- add/modify a TypeScript backend in `src/orchestrator/backends/`
- wire backend selection in `src/orchestrator/index.ts` and keep setup validation in `setup/pi/configure.sh`

Then verify install path:

- `setup/pi/configure.sh` `install_archive_scripts()`

### “I want to tune snapshots / file retention / free space”

Start here:

- `run/make_snapshot.sh`
- `run/release_snapshot.sh`
- `run/manage_free_space.sh`
- snapshot cadence and trigger points in `src/orchestrator/runtime-lifecycle-loop.ts`

### “I want to change web UI or diagnostics pages”

Start here:

- `teslausb-www/html/` (legacy/static pages)
- `teslausb-www/teslausb.nginx` (routing/auth/static behavior)
- `setup/pi/configure-web.sh` (deployment mechanics)

Important: setup also fetches a prebuilt UI tarball from the external `teslausb-webui` project.

### “I want to change setup/config validation behavior”

Start here:

- `setup/pi/setup-teslausb` (install/upgrade flow)
- `setup/pi/envsetup.sh` (config loading/defaults/compat vars)
- `setup/pi/configure.sh` (validation, package install, systemd wiring)

### “I want to add a notification provider”

Start here:

- `run/send-push-message` (provider dispatch)
- `setup/pi/configure.sh` (validation + package install + enable flags)

If Python deps are needed, follow existing patterns (`send_sns.py`, `send_matrix.py`).

### “I want to change USB gadget / car-facing behavior”

Start here:

- `run/enable_gadget.sh`
- `run/disable_gadget.sh`
- attachment timing in `src/orchestrator/runtime-lifecycle-loop.ts`
- relevant boot module behavior in `setup/pi/setup-teslausb`

---

## 5) Data & mount model

- Backing image files live under `/backingfiles/*.bin` (cam/music/etc).
- Active mutable runtime state/logs primarily under `/mutable` and `/tmp`.
- Snapshots are stored in `/backingfiles/snapshots/snap-*` with autofs mount views under `/tmp/snapshots/...`.
- Camera clip visibility for archive/web is mostly symlink-driven and overlay-assisted in the orchestrator flow (`src/orchestrator/*`, legacy: `run/archiveloop`).

When editing mount/snapshot code, assume concurrency with:

- autofs,
- long-running orchestrator service,
- potential abrupt power loss from vehicle USB behavior.

---

## 6) Concurrency, reliability, and safety patterns

Patterns used heavily across scripts:

- lock guards via `flock` (`FLOCKED` pattern) to avoid concurrent script instances
- aggressive retries around mount/network actions
- filesystem repair (`fsck`) before exposing drives
- defensive unmount/lazy unmount fallbacks
- service-level restart (`Restart=always`) for `teslausb-node.service`

If introducing new runtime scripts, follow those same patterns first before adding complexity.

---

## 7) Suggested contributor workflow

1. Pick a change goal from section 4 and start with the listed files.
2. Validate shell syntax/style with `check.sh` (ShellCheck wrapper).
3. Keep changes backend-local when possible (`run/<backend>_archive/*`).
4. If setup behavior changes, test both fresh setup and upgrade path (`setup-teslausb upgrade/install`).
5. For runtime changes, check journald for `teslausb-node.service` and runtime status artifacts under `/mutable`.

### TypeScript coding standards

For code under `src/`, apply these standards by default:

1. Add TSDoc comments to all functions (including private helpers and exported APIs).
2. Add TSDoc comments to significant variables (for example: constants that encode behavior, non-obvious state holders, and values with units/constraints).
3. Keep comments brief and accurate; prefer one or two clear sentences over long narrative text.
4. If intent is obvious from naming and type alone, skip variable comments; when in doubt, document it.

This is a project-level requirement, not an optional style preference.

### Upgrade compatibility requirements

When changing runtime behavior, preserve upgrade compatibility by default:

1. Existing documented behavior must continue to work after upgrade unless there is an explicit migration plan.
2. New optional behavior must require manual configuration (opt-in) before it changes runtime behavior.
3. If new behavior becomes the default, update project documentation in the same change set and clearly call out the behavior change.
4. Pull requests should state whether behavior is unchanged, opt-in, or default-changed and where that is documented.

---

## 8) Quick “owner map” (fast lookup)

- **Main runtime brain:** `src/orchestrator/index.ts`
- **Installer/upgrade entrypoint:** `setup/pi/setup-teslausb`
- **Config defaults + variable migration:** `setup/pi/envsetup.sh`
- **Runtime + systemd wiring:** `setup/pi/configure.sh`
- **Web stack deployment:** `setup/pi/configure-web.sh`
- **Autofs maps:** `run/auto.teslausb`, `run/auto.www`
- **Snapshot logic:** `run/make_snapshot.sh`
- **Notification fan-out:** `run/send-push-message`

If you are unsure where to start, begin at `src/orchestrator/index.ts` and trace outward to whichever helper it calls for your feature area.

---

## 9) Sync status indicators (backlog/lag)

Current sync lag indicators are implemented through a small status pipeline:

1. `run/archiveloop` computes queue/lag metrics during archive passes and writes `/mutable/sync_status`.
2. `teslausb-www/html/cgi-bin/status.sh` reads `/mutable/sync_status` and includes fields in its JSON response.
3. `teslausb-www/html/index.html` renders those values in the status panel (`.status_sync`).

If you want to add more “how far behind” indicators, this is the preferred extension path.
---

## 10) Live testing & deployment workflow

### Quick orientation

When you make changes to TeslaUSB, you test them on a live car instance by:

1. Pushing your changes to a Git branch in your fork.
2. Configuring the car's device to pull from your fork/branch.
3. Running the official upgrade path (`setup-teslausb upgrade`).
4. Validating changes with live sync tests and log inspection.
5. Rolling back if needed by reverting config and re-running upgrade.

This mimics the production flow and catches integration issues early.

### Step 1: Prepare a test branch locally

```bash
# Make your changes in a feature branch (not main)
git checkout -b my-feature
# ... edit files ...
git add .
git commit -m "Add lag indicators to archiveloop"
git push -u origin my-feature
```

### Step 2: Configure the car device for your branch

SSH into your car's Pi and edit the config file:

```bash
ssh root@teslausb.lan
sudo -i
nano /root/teslausb_setup_variables.conf
```

Add or update these lines to point to your fork:

```bash
export REPO=your-github-username
export BRANCH=my-feature
```

Save and exit.

### Step 3: Run the upgrade (safe path)

The official upgrade process handles all state transitions safely:

```bash
/root/bin/setup-teslausb upgrade
```

**What this does:**
- Downloads your branch tarball from GitHub.
- Stops the running `teslausb-node.service` and related helpers.
- Validates configuration.
- Installs/updates all scripts and system configuration.
- Re-enables and restarts services.
- Preserves all backingfiles and user data under `/backingfiles/` and `/mutable/`.

**Why not manual file copies?**
Because the upgrade path properly handles:
- Service lifecycle (stop → reconfigure → start).
- Systemd unit updates.
- Backend/archive module selection/validation.
- Environment variable migrations.
- Concurrent script protection (flock guards).

### Step 4: Validate your changes

**Check service health:**

```bash
systemctl status teslausb-node --no-pager
# should show: Active (running)

# view recent log output
tail -n 50 /mutable/archiveloop.log
```

**For runtime changes (like sync indicators), test a forced sync cycle:**

```bash
# while parked at home with archive reachable:
# Option A: click "Trigger archive/sync" in web UI
# Option B: command line:
touch /tmp/archive_is_unreachable  # persuade device archive is unreachable
sleep 5
rm /tmp/archive_is_unreachable     # suddenly reachable again (triggers sync)

# watch logs in real-time:
tail -f /mutable/archiveloop.log
```

**Check new metrics live:**

```bash
# for sync status indicator feature:
cat /mutable/sync_status
curl -s http://localhost/cgi-bin/status.sh | jq '.sync_*'
```

**Verify via web UI:**

Open http://teslausb.lan (or IP address) and check:
- Dashboard status panel for your new indicators.
- "Archiveloop log" tab for errors/warnings.
- "Diagnostics" tab for full system health.

### Step 5: Rollback (if needed)

If something breaks:

```bash
ssh root@teslausb.lan
sudo -i
nano /root/teslausb_setup_variables.conf

# Revert to stable:
export REPO=marcone
export BRANCH=main-dev

# Run upgrade again
/root/bin/setup-teslausb upgrade

# verify service restarted:
systemctl status teslausb-node
journalctl -u teslausb-node -n 20 --no-pager
```

### Testing checklist

Before declaring a change "ready," verify:

- [ ] Shell scripts pass syntax check: `bash -n run/archiveloop` (or affected files).
- [ ] Service starts cleanly: `systemctl status teslausb` shows `Active (running)`.
- [ ] Archiveloop log has no new errors: `grep -i error /mutable/archiveloop.log | tail -20`.
- [ ] Expected behavior observed in a real sync cycle (parked at home, trigger sync).
- [ ] Web UI displays any new indicators without JS errors (browser console).
- [ ] Rollback path works (revert branch, upgrade again, verify rollback completes).

### Common pitfalls

1. **Editing files directly on device** (without re-running upgrade) → changes are lost on reboot or next upgrade.
2. **Not waiting for archiveloop to settle** → logs can be misleading during startup; wait 30–60 seconds before checking status.
3. **Testing while away from home** → if archive is unreachable, archiveloop won't test the archive/sync code paths.
4. **Forgetting both `REPO` and `BRANCH`** → upgrade will silently use defaults; check `/root/teslausb_setup_variables.conf` before/after upgrade.

### Advanced: Staged testing

For large changes, consider:

1. **Develop locally** → run tests against code (static lint, unit tests if applicable).
2. **Test in a "none" archive mode** → on the car, with `ARCHIVE_SYSTEM=none`, sync logic runs but no data leaves device.
3. **Single-backend test** → if adding multi-backend support, test one backend thoroughly before others.
4. **Dogfood before release** → run your branch on your own car for a week before opening a PR.

---

## 11) Full TypeScript Modernization Roadmap (v2.0)

### Vision

Migrate the entire TeslaUSB application—including `archiveloop`, all archive backends, API layer, and web UI—to a **strongly-typed TypeScript monorepo**. This improves:

- **Type safety** across runtime orchestration, state management, and API contracts.
- **Testability** with unit, integration, and e2e test suites.
- **Developer experience** with IDE intellisense, auto-completion, and compile-time error catching.
- **Maintainability** with a unified language, shared types, and clear module boundaries.
- **Time-to-contribution** for new developers (no Bash expertise required).

### New Repository Structure (v2.0)

```
teslausb/
├── src/
│   ├── types/                   # Shared TypeScript interfaces & types
│   │   ├── config.ts            # Configuration (zod-validated)
│   │   ├── archive.ts           # Archive system types
│   │   ├── orchestrator.ts       # Orchestrator state & events
│   │   └── api.ts               # API request/response schemas
│   │
│   ├── core/
│   │   ├── logger.ts            # Structured logging (pino)
│   │   ├── config-loader.ts      # Load & validate /root/teslausb_setup_variables.conf
│   │   ├── state-manager.ts      # Filesystem-backed state with TS wrappers
│   │   └── event-bus.ts          # Inter-component communication
│   │
│   ├── orchestrator/             # archiveloop v2.0 (core event loop)
│   │   ├── index.ts              # Main orchestrator loop
│   │   ├── archive-manager.ts     # Archive lifecycle (connect/disconnect/sync)
│   │   ├── snapshot-manager.ts    # Snapshot creation/retention/cleanup
│   │   ├── free-space-manager.ts  # Disk pressure handling
│   │   ├── usb-gadget-manager.ts  # USB attach/detach
│   │   └── idle-waiter.ts         # Car idle detection
│   │
│   ├── archive-backends/         # Pluggable archive systems
│   │   ├── base.ts               # Abstract backend interface
│   │   ├── rsync/
│   │   ├── rclone/
│   │   ├── cifs/
│   │   ├── nfs/
│   │   └── none/
│   │
│   ├── api/                       # Express.js web API
│   │   ├── server.ts              # API bootstrap
│   │   ├── routes/
│   │   │   ├── status.ts          # GET /api/status
│   │   │   ├── logs.ts            # GET /api/logs
│   │   │   ├── config.ts          # GET/POST /api/config
│   │   │   ├── sync.ts            # POST /api/sync/trigger
│   │   │   ├── system.ts          # GET /api/system (uptime, temp, etc)
│   │   │   └── diagnostics.ts     # GET /api/diagnostics
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── error-handler.ts
│   │   │   └── logging.ts
│   │   └── schemas/               # Zod schemas for request/response validation
│   │
│   ├── frontend/                  # React/TypeScript SPA
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── services/api/          # Generated from OpenAPI spec
│   │   └── types/                 # Frontend-specific types
│   │
│   ├── scripts/                   # One-off utilities, migrations
│   └── __tests__/                 # Unit, integration, e2e tests
│       ├── unit/
│       ├── integration/
│       └── e2e/
│
├── dist/                          # Compiled output for Pi deployment
├── docker-compose.dev.yml         # Local dev environment (mock archiveloop state)
├── package.json / pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts               # Test runner config
├── docker/                        # Production Dockerfile for Pi deployment
└── docs/                          # Developer guides, API reference
```

### Core Architectural Decisions

#### 1. **Config Validation (Zod)**

```typescript
// src/types/config.ts
import { z } from 'zod';

export const ConfigSchema = z.object({
  archiveSystem: z.enum(['rsync', 'rclone', 'cifs', 'nfs', 'none']),
  rsyncServer: z.string().optional(),
  rsyncUser: z.string().optional(),
  // ... all other config
});

export type TeslaUSBConfig = z.infer<typeof ConfigSchema>;
```

Replaces env var chaos with **runtime-validated types**. Config loader parses `/root/teslausb_setup_variables.conf` and fails fast if invalid.

#### 2. **State Management (Filesystem + Types)**

```typescript
// src/core/state-manager.ts
export class StateManager {
  async writeSyncStatus(status: SyncStatus): Promise<void> {
    // Write to /mutable/sync_status as JSON
    // Type-safe: SyncStatus interface ensures correctness
  }

  async readArchiveloopLog(): Promise<string> {
    // Read from /mutable/archiveloop.log
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    // Query /backingfiles/snapshots/snap-{id}/
  }
}
```

Keeps state on disk (for persistence, concurrency, shell script interop) but wraps it in TypeScript classes.

#### 3. **Event-Driven Orchestrator**

```typescript
// src/orchestrator/index.ts
export class Orchestrator extends EventEmitter {
  async run(): Promise<void> {
    while (true) {
      this.emit('archiveLoop:start');

      const isReachable = await this.archiveManager.isReachable();
      if (isReachable) {
        this.emit('archiveLoop:archiving');
        await this.archiveManager.syncClips();
        this.emit('archiveLoop:archivingComplete');
      }

      this.emit('archiveLoop:waitingForArchive');
      await this.waitForArchiveStateChange();
    }
  }
}
```

Replaces ad-hoc bash control flow with **clear event lifecycle**, easier to test and monitor.

#### 4. **Structured Logging (Pino)**

```typescript
// All modules
import { logger } from './core/logger';

logger.info({ files: 100, events: 5 }, 'Starting archive');
logger.error({ error: err.message }, 'Archive failed');
```

Replaces `echo "..."` >> `/mutable/archiveloop.log` with JSON-structured logs, easier to parse, monitor, and aggregate.

#### 5. **Archive Backend Interface**

```typescript
// src/archive-backends/base.ts
export abstract class ArchiveBackend {
  abstract name: string;

  abstract verify(): Promise<void>;
  abstract isReachable(): Promise<boolean>;
  abstract connect(): Promise<void>;
  abstract archiveClips(filePaths: string[]): Promise<{ archived: number; failed: number }>;
  abstract copyMusic(sourcePath: string): Promise<void>;
  abstract disconnect(): Promise<void>;
}
```

All backends (rsync, cifs, etc.) implement this interface. Type-safe plugin system.

#### 6. **REST API (Express + OpenAPI)**

```typescript
// src/api/routes/status.ts
import { Router } from 'express';
import { StatusSchema } from '../schemas';

const router = Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await orchestrator.getStatus();
    const validated = StatusSchema.parse(status);
    res.json(validated);
  } catch (err) {
    next(err);
  }
});
```

Auto-generate OpenAPI 3.0 spec from route definitions. Frontend uses generated TypeScript client.

#### 7. **Frontend (React + TypeScript)**

```typescript
// src/frontend/components/SyncStatus.tsx
import { useSyncStatus } from '../hooks/useStatus';

export const SyncStatus: React.FC = () => {
  const { status, isLoading, error } = useSyncStatus();

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>Backlog: {status.sync_queue_files} files</p>
      <p>Oldest pending: {formatDuration(status.sync_queue_oldest_age_sec)}</p>
    </div>
  );
};
```

Modern React, TypeScript client auto-generated from API schema, proper error boundaries and loading states.

### Implementation Phases

#### Legacy decommission policy

- Migration is **not required** to be strict 1:1 file-for-file from bash/CGI to TypeScript.
- TypeScript may consolidate or split responsibilities differently than legacy scripts.
- A legacy file should be deleted as soon as all of the following are true:
  - Its behavior is implemented in TypeScript and covered by tests.
  - No runtime/setup path references it anymore.
  - Removal does not change user-visible behavior or deployment safety.
- Prefer deleting defunct legacy files in the same PR where replacement reaches parity.

#### Phase 1: Foundation & Core Types (Weeks 1–2)

**Goals:**
- Set up TypeScript monorepo (pnpm workspaces, tsconfig).
- Create shared type definitions (Config, SyncStatus, ArchiveBackend interface, etc.).
- Implement ConfigLoader + StateManager.
- Unit tests for types and config validation.

**Deliverables:**
- `src/types/`, `src/core/` modules complete.
- Test coverage for config loading and state reads/writes.
- Dev environment (local TypeScript compilation works).

**Risk level:** Low. No runtime changes yet.

#### Phase 2: Orchestrator Core (Weeks 3–5)

**Goals:**
- Rewrite archiveloop as TypeScript Orchestrator class.
- Implement archive lifecycle (connect/disconnect/sync).
- Implement snapshot and free-space managers.
- Stub out archive backends (interface, no real operations yet).

**Deliverables:**
- `src/orchestrator/` complete, passes dry-run tests.
- Archive backends as stubs (inherit from interface, no-op methods).
- Unit tests for orchestrator logic, snapshot decision-making, free-space thresholds.

**Risk level:** Low. Runs locally in test mode; not deployed yet.

#### Phase 3: Archive Backends (Weeks 6–8)

**Goals:**
- Migrate each backend (rsync, cifs, nfs, rclone, none) to TypeScript.
- Implement real calls (spawn rsync, mount CIFS, etc.).
- Backend-specific tests.

**Deliverables:**
- All 5 backends implemented, tested with mock data.
- Integration tests for each backend.

**Risk level:** Medium. First real I/O, but still test-only.

#### Phase 4: API Layer (Weeks 9–11)

**Goals:**
- Implement Express web server.
- Routes: status, logs, config, sync control, diagnostics.
- Request/response validation via Zod.
- OpenAPI spec generation.

**Deliverables:**
- `/api/status`, `/api/logs`, `/api/sync/trigger`, etc. all working.
- OpenAPI 3.0 spec auto-generated.
- Integration tests for API endpoints.

**Risk level:** Low–Medium. API wraps orchestrator; safe to test in parallel.

#### Phase 5: Frontend (Weeks 12–14)

**Goals:**
- Build React SPA with TypeScript.
- Generate API client from OpenAPI spec.
- Migrate existing UI features (status panel, logs viewer, sync trigger, diagnostics).

**Deliverables:**
- Full web UI in React/TS.
- E2E tests using Playwright or Cypress.

**Risk level:** Medium. Complex frontend logic, but orchestrator unaffected.

#### Phase 6: Pi Deployment & Testing (Weeks 15–17)

**Goals:**
- Build and bundle for Pi deployment.
- Docker image for reproducible builds.
- Test on real Pi Zero (memory, CPU under load).
- Rollback procedures and safety checks.

**Deliverables:**
- Docker image that runs on Pi.
- Performance benchmarks (memory, CPU, latency).
- Upgrade/migration guide for users on v1.x.
- Rollback automation.

**Risk level:** High. First real-device test; may need optimization.

### Testing Strategy

#### Unit Tests

```bash
pnpm test:unit
# Covers: config validation, state manager, archive backend interface, orchestrator logic
```

#### Integration Tests

```bash
pnpm test:integration
# Covers: orchestrator + mocked backends, API + state manager, end-to-end sync cycles
```

#### E2E Tests (Local)

```bash
pnpm test:e2e:local
# Covers: full stack (orchestrator + API + frontend) with mocked archiveloop state
# Docker compose spins up mock services, tests UI interactions
```

#### E2E Tests (Real Pi)

```bash
pnpm test:e2e:pi --host teslausb.lan
# Covers: real device, real archiveloop, real sync cycles
# Requires car to be at home with archive reachable
```

### Developer Setup (Local)

```bash
# Clone repo
git clone https://github.com/your-fork/teslausb.git
cd teslausb

# Install dependencies
pnpm install

# Start dev environment (Docker Compose)
docker-compose -f docker-compose.dev.yml up

# In another terminal, run dev server
pnpm dev

# Visit http://localhost:3000 for frontend
# API at http://localhost:3001/api

# Run tests
pnpm test
pnpm test:watch
```

### Pi Deployment (v2.0)

```bash
# On device
ssh root@teslausb.lan

# Pull v2.0
export REPO=your-fork
export BRANCH=v2.0-ts
/root/bin/setup-teslausb upgrade

# Systemd unit runs compiled Node.js app
systemctl status teslausb-node
journalctl -u teslausb-node -f
```

The setup script downloads pre-built bundle (or builds on-device if needed).

### Migration Path for v1.x Users

1. **v1.x stays on `main-dev` branch.** Bash version receives critical bugfixes only.
2. **v2.0 launches as `v2.0` branch** when ready.
3. **Users opt-in:** Set `BRANCH=v2.0` and run upgrade.
4. **Rollback:** Set `BRANCH=main-dev` and upgrade again.
5. **After 6 months:** v1.x enters maintenance mode, v2.0 becomes default.

**Backward compatibility:** v2.0 reads existing config (`/root/teslausb_setup_variables.conf`), respects existing layouts (`/backingfiles/`, `/mutable/`), so users don't lose data.

### Performance & Resource Constraints

**Target (Pi Zero, 512 MB RAM):**
- Base Node.js app: ~50–70 MB.
- Orchestrator + API + frontend: ~100–150 MB total (acceptable with swap).
- CPU usage: <30% during idle, <70% during active sync (similar to v1.x bash).

**Optimization techniques:**
- Use `esbuild` for fast bundling.
- Tree-shake unused code.
- Use `pkg` to bundle Node.js + app into single binary.
- Resource limits in systemd unit.

**Validation checklist:**
- [ ] Memory profiling during sustained archiveloop operation.
- [ ] CPU profiling during concurrent snapshot + sync + web requests.
- [ ] Startup time <10 seconds.
- [ ] API response time <100ms (p99).

### Key Benefits

✅ **Type safety** from config loading to API responses.  
✅ **Testability** with proper dependency injection and mocking.  
✅ **Developer velocity** — IDE intellisense, auto-generation of API clients.  
✅ **Maintainability** — single language, clear module boundaries, no bash quirks.  
✅ **Extensibility** — easy to add new archive backends or API endpoints.  
✅ **Monitoring** — structured logs, metrics, event tracing.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Node.js memory overhead on Pi Zero | Resource limits, profiling, fallback to v1.x if needed |
| Regression in archiveloop reliability | Extensive unit/integration tests, staged rollout, monitoring |
| Compilation complexity for Pi deployment | Pre-built binaries, Docker images, CI/CD automation |
| Breaking changes for v1.x users | Clear migration guide, dual-branch support, rollback docs |
| Onboarding overhead for new TS developers | Good docs, open PRs, code examples, ADRs (Architecture Decision Records) |

### Success Criteria

- ✅ All tests passing (unit + integration + e2e).
- ✅ Deployed on real Pi Zero, 1 week of production use without crashes.
- ✅ Performance parity with v1.x (memory, CPU, sync speed).
- ✅ User upgrades from v1.x → v2.0 without data loss.
- ✅ Rollback from v2.0 → v1.x works cleanly.
- ✅ New contributors can add features within 1 day of onboarding.