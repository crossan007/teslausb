import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigLoader } from '../config/config-loader';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

describe('ConfigLoader', () => {
  let configLoader: ConfigLoader;
  let tempConfigPath: string;

  beforeEach(() => {
    // Save original env
    vi.stubEnv('ARCHIVE_SYSTEM', 'none');
    vi.stubEnv('TESLA_EMAIL', 'test@example.com');
    vi.stubEnv('ARCHIVE_DELAY', '300');
    
    tempConfigPath = join(tmpdir(), `test-config-${Date.now()}.conf`);
  });

  afterEach(() => {
    // Clean up temp file
    try {
      unlinkSync(tempConfigPath);
    } catch {
      // File may not exist
    }
    vi.unstubAllEnvs();
  });

  it('loads default values when no config exists', () => {
    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.archiveSystem).toBe('none');
    expect(config.camSize).toBe('500');
    expect(config.musicSize).toBe('500');
  });

  it('loads from environment variables', () => {
    configLoader = new ConfigLoader('/nonexistent/path');
    
    vi.stubEnv('ARCHIVE_SYSTEM', 'rsync');
    vi.stubEnv('RSYNC_SERVER', 'backup.example.com');
    vi.stubEnv('RSYNC_USER', 'user123');
    vi.stubEnv('ARCHIVE_DELAY', '600');

    const config = configLoader.load();

    expect(config.archiveSystem).toBe('rsync');
    expect(config.rsyncServer).toBe('backup.example.com');
    expect(config.rsyncUser).toBe('user123');
    expect(config.archiveDelay).toBe(600);
  });

  it('parses booleans from environment', () => {
    vi.stubEnv('PUSHOVER_ENABLED', 'true');
    vi.stubEnv('SLACK_ENABLED', 'false');

    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.pushoverEnabled).toBe(true);
    expect(config.slackEnabled).toBe(false);
  });

  it('loads from file', () => {
    const fileContent = `
export ARCHIVE_SYSTEM=rclone
export RCLONE_DRIVE=MyDrive
export TESLA_EMAIL=john@example.com
export ARCHIVE_DELAY=900
`;
    writeFileSync(tempConfigPath, fileContent, 'utf-8');
    
    configLoader = new ConfigLoader(tempConfigPath);
    const config = configLoader.load();

    expect(config.archiveSystem).toBe('rclone');
    expect(config.rcloneDrive).toBe('MyDrive');
    expect(config.teslaEmail).toBe('john@example.com');
    expect(config.archiveDelay).toBe(900);
  });

  it('preferrs file config over environment', () => {
    vi.stubEnv('ARCHIVE_SYSTEM', 'rsync');
    vi.stubEnv('ARCHIVE_DELAY', '300');

    const fileContent = `
export ARCHIVE_SYSTEM=rclone
export ARCHIVE_DELAY=600
`;
    writeFileSync(tempConfigPath, fileContent, 'utf-8');

    configLoader = new ConfigLoader(tempConfigPath);
    const config = configLoader.load();

    expect(config.archiveSystem).toBe('rclone');
    expect(config.archiveDelay).toBe(600);
  });

  it('handles quoted values in file', () => {
    const fileContent = `
export TESLA_EMAIL="user@example.com"
export RSYNC_SERVER='backup.server.com'
`;
    writeFileSync(tempConfigPath, fileContent, 'utf-8');

    configLoader = new ConfigLoader(tempConfigPath);
    const config = configLoader.load();

    expect(config.teslaEmail).toBe('user@example.com');
    expect(config.rsyncServer).toBe('backup.server.com');
  });

  it('validates configuration schema', () => {
    vi.stubEnv('ARCHIVE_SYSTEM', 'invalid_system');

    configLoader = new ConfigLoader('/nonexistent/path');
    
    expect(() => configLoader.load()).toThrow();
  });

  it('caches loaded config', () => {
    configLoader = new ConfigLoader('/nonexistent/path');
    
    const config1 = configLoader.load();
    const config2 = configLoader.get();

    expect(config1).toBe(config2);
  });

  it('returns cached config on get() without reloading', () => {
    const fileContent = `export ARCHIVE_SYSTEM=rsync`;
    writeFileSync(tempConfigPath, fileContent, 'utf-8');

    configLoader = new ConfigLoader(tempConfigPath);
    
    // First load
    const config1 = configLoader.load();
    expect(config1.archiveSystem).toBe('rsync');

    // Modify file
    writeFileSync(tempConfigPath, `export ARCHIVE_SYSTEM=rclone`, 'utf-8');

    // Get should return cached version
    const config2 = configLoader.get();
    expect(config2.archiveSystem).toBe('rsync');
  });

  it('provides sensible defaults for all optional fields', () => {
    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.camSize).toBe('500');
    expect(config.musicSize).toBe('500');
    expect(config.archiveDelay).toBe(300);
    expect(config.archiveSavedclips).toBe(true);
    expect(config.upgradePackages).toBe(false);
  });

  it('handles notification configuration', () => {
    vi.stubEnv('PUSHOVER_ENABLED', 'true');
    vi.stubEnv('PUSHOVER_USER_KEY', 'user123');
    vi.stubEnv('PUSHOVER_APP_KEY', 'app456');
    vi.stubEnv('DISCORD_ENABLED', 'false');

    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.pushoverEnabled).toBe(true);
    expect(config.pushoverUserKey).toBe('user123');
    expect(config.pushoverAppKey).toBe('app456');
    expect(config.discordEnabled).toBe(false);
  });

  it('handles Tesla API configuration', () => {
    vi.stubEnv('TESLA_EMAIL', 'owner@tesla.com');
    vi.stubEnv('TESLA_PASSWORD', 'secure123');
    vi.stubEnv('TESLA_VIN', 'LRWXYZ123456789AB');
    vi.stubEnv('TESSIE_API_TOKEN', 'abc123token');

    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.teslaEmail).toBe('owner@tesla.com');
    expect(config.teslaPassword).toBe('secure123');
    expect(config.teslaVin).toBe('LRWXYZ123456789AB');
    expect(config.tessieApiToken).toBe('abc123token');
  });

  it('handles SMB/CIFS configuration', () => {
    vi.stubEnv('SHARE_NAME', 'media');
    vi.stubEnv('SHARE_USER', 'admin');
    vi.stubEnv('SHARE_PASSWORD', 'pass123');
    vi.stubEnv('SHARE_DOMAIN', 'corp.local');
    vi.stubEnv('MUSIC_SHARE_NAME', 'music');

    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.shareName).toBe('media');
    expect(config.shareUser).toBe('admin');
    expect(config.sharePassword).toBe('pass123');
    expect(config.shareDomain).toBe('corp.local');
    expect(config.musicShareName).toBe('music');
  });

  it('handles NFS configuration', () => {
    vi.stubEnv('ARCHIVE_SERVER', 'nfs.example.com');

    configLoader = new ConfigLoader('/nonexistent/path');
    const config = configLoader.load();

    expect(config.archiveServer).toBe('nfs.example.com');
  });
});
