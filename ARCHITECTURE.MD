# TeslaUSB Architecture Guide

This guide is for contributors who want to quickly answer:

- **How does TeslaUSB work end-to-end?**
- **Where should I edit for a specific behavior?**
- **What are the extension points and safe change boundaries?**

---

## 1) Mental model (in one minute)

TeslaUSB is a **script-driven embedded system** that turns a Raspberry Pi/SBC into a USB drive for Tesla, while also:

- continuously snapshotting and cleaning the camera filesystem,
- archiving clips when home network storage is reachable,
- exposing recordings and diagnostics via nginx/web UI.

The architecture has 4 layers:

1. **Provisioning layer** (`setup/pi/*`): validates config, installs scripts, configures OS services.
2. **Runtime orchestrator** (`run/archiveloop`): the long-running control loop.
3. **Pluggable archive backends** (`run/*_archive/*`): rsync, rclone, cifs, nfs, none.
4. **Web and mount layer** (`teslausb-www/*`, `run/auto.*`, snapshot scripts): browsing/download UX and autofs mounts.

---

## 2) End-to-end lifecycle

### Install / upgrade lifecycle

- Main installer entrypoint: `setup/pi/setup-teslausb`
- Reads user config via: `setup/pi/envsetup.sh` (`/root/teslausb_setup_variables.conf`)
- Runs configuration pipeline in: `setup/pi/configure.sh`
- Picks archive module with `get_archive_module()` and installs module scripts to `/root/bin`
- Writes and enables systemd unit `teslausb.service` that runs `/root/bin/archiveloop`

### Runtime lifecycle (service)

- Service entrypoint: `run/archiveloop`
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

- `archiveloop`: **core orchestrator**
- `make_snapshot.sh` / `release_snapshot.sh`: snapshot creation & retention mechanics
- `manage_free_space.sh`: camera disk space pressure handling
- `enable_gadget.sh` / `disable_gadget.sh`: USB gadget attach/detach
- `waitforidle`: car-idle gating before writes
- `send-push-message`: fan-out notification dispatcher
- `temperature_monitor`: periodic thermal checks/notifications

## Archive backend modules

Each backend directory (`run/rsync_archive`, `run/cifs_archive`, `run/nfs_archive`, `run/rclone_archive`, `run/none_archive`) provides a contract consumed by `archiveloop`:

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

- `run/archiveloop` (file list generation, short-file filtering, retry/connect loop)
- `run/<backend>_archive/archive-clips.sh` (backend transfer command details)

Good to also inspect:

- `run/<backend>_archive/connect-archive.sh`
- `run/<backend>_archive/archive-is-reachable.sh`

### “I want to add or modify an archive backend”

Start here:

- create/modify `run/<new>_archive/*` with the contract above
- update backend selection in `setup/pi/configure.sh` (`get_archive_module`, config validation)

Then verify install path:

- `setup/pi/configure.sh` `install_archive_scripts()`

### “I want to tune snapshots / file retention / free space”

Start here:

- `run/make_snapshot.sh`
- `run/release_snapshot.sh`
- `run/manage_free_space.sh`
- snapshot cadence and trigger points in `run/archiveloop`

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
- attachment timing in `run/archiveloop`
- relevant boot module behavior in `setup/pi/setup-teslausb`

---

## 5) Data & mount model

- Backing image files live under `/backingfiles/*.bin` (cam/music/etc).
- Active mutable runtime state/logs primarily under `/mutable` and `/tmp`.
- Snapshots are stored in `/backingfiles/snapshots/snap-*` with autofs mount views under `/tmp/snapshots/...`.
- Camera clip visibility for archive/web is mostly symlink-driven and overlay-assisted in `archiveloop`.

When editing mount/snapshot code, assume concurrency with:

- autofs,
- long-running `archiveloop`,
- potential abrupt power loss from vehicle USB behavior.

---

## 6) Concurrency, reliability, and safety patterns

Patterns used heavily across scripts:

- lock guards via `flock` (`FLOCKED` pattern) to avoid concurrent script instances
- aggressive retries around mount/network actions
- filesystem repair (`fsck`) before exposing drives
- defensive unmount/lazy unmount fallbacks
- service-level restart (`Restart=always`) for `teslausb.service`

If introducing new runtime scripts, follow those same patterns first before adding complexity.

---

## 7) Suggested contributor workflow

1. Pick a change goal from section 4 and start with the listed files.
2. Validate shell syntax/style with `check.sh` (ShellCheck wrapper).
3. Keep changes backend-local when possible (`run/<backend>_archive/*`).
4. If setup behavior changes, test both fresh setup and upgrade path (`setup-teslausb upgrade/install`).
5. For runtime changes, check logs in `/mutable/archiveloop.log` and service status for `teslausb.service`.

---

## 8) Quick “owner map” (fast lookup)

- **Main runtime brain:** `run/archiveloop`
- **Installer/upgrade entrypoint:** `setup/pi/setup-teslausb`
- **Config defaults + variable migration:** `setup/pi/envsetup.sh`
- **Runtime + systemd wiring:** `setup/pi/configure.sh`
- **Web stack deployment:** `setup/pi/configure-web.sh`
- **Autofs maps:** `run/auto.teslausb`, `run/auto.www`
- **Snapshot logic:** `run/make_snapshot.sh`
- **Notification fan-out:** `run/send-push-message`

If you are unsure where to start, begin at `run/archiveloop` and trace outward to whichever helper it calls for your feature area.

---

## 9) Sync status indicators (backlog/lag)

Current sync lag indicators are implemented through a small status pipeline:

1. `run/archiveloop` computes queue/lag metrics during archive passes and writes `/mutable/sync_status`.
2. `teslausb-www/html/cgi-bin/status.sh` reads `/mutable/sync_status` and includes fields in its JSON response.
3. `teslausb-www/html/index.html` renders those values in the status panel (`.status_sync`).

If you want to add more “how far behind” indicators, this is the preferred extension path.
