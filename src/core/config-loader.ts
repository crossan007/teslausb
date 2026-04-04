import { readFileSync } from 'fs';
import { logger } from './logger';
import { ConfigSchema, TeslaUSBConfig } from '../types';

/**
 * Loads and validates TeslaUSB configuration from /root/teslausb_setup_variables.conf
 * Falls back to environment variables for each config key.
 */
export class ConfigLoader {
  private config: TeslaUSBConfig | null = null;
  private readonly booleanEnvKeys = new Set([
    'ARCHIVE_SAVEDCLIPS',
    'ARCHIVE_SENTRYCLIPS',
    'ARCHIVE_TRACKMODECLIPS',
    'ARCHIVE_RECENTCLIPS',
    'PUSHOVER_ENABLED',
    'GOTIFY_ENABLED',
    'DISCORD_ENABLED',
    'SLACK_ENABLED',
    'TELEGRAM_ENABLED',
    'NTFY_ENABLED',
    'UPGRADE_PACKAGES',
  ]);
  private readonly numericEnvKeys = new Set([
    'ARCHIVE_DELAY',
    'SENTRY_CASE',
    'GOTIFY_PRIORITY',
  ]);

  constructor(private configPath: string = '/root/teslausb_setup_variables.conf') {}

  /**
   * Load and validate configuration.
   * Throws if configuration is invalid.
   */
  load(): TeslaUSBConfig {
    if (this.config) {
      return this.config;
    }

    const envConfig = this.loadFromEnvironment();
    const fileConfig = this.loadFromFile();

    // Merge: file overrides env, env overrides defaults
    const merged = { ...envConfig, ...fileConfig };

    try {
      this.config = ConfigSchema.parse(merged);
      logger.info({ config: this.sanitizeLogging(this.config) }, 'Configuration loaded');
      return this.config;
    } catch (error) {
      logger.error({ error, merged }, 'Configuration validation failed');
      throw new Error(`Invalid configuration: ${error}`);
    }
  }

  /**
   * Get cached config, or load if not already loaded.
   */
  get(): TeslaUSBConfig {
    return this.config ?? this.load();
  }

  /**
   * Load configuration from environment variables.
   * Convention: UPPER_SNAKE_CASE env vars map to camelCase config keys.
   */
  private loadFromEnvironment(): Record<string, any> {
    const mapping: Record<string, string> = {
      ARCHIVE_SYSTEM: 'archiveSystem',
      RSYNC_SERVER: 'rsyncServer',
      RSYNC_USER: 'rsyncUser',
      RSYNC_PATH: 'rsyncPath',
      RCLONE_DRIVE: 'rcloneDrive',
      RCLONE_PATH: 'rclonePath',
      ARCHIVE_SERVER: 'archiveServer',
      SHARE_NAME: 'shareName',
      MUSIC_SHARE_NAME: 'musicShareName',
      SHARE_USER: 'shareUser',
      SHARE_PASSWORD: 'sharePassword',
      SHARE_DOMAIN: 'shareDomain',
      CAM_SIZE: 'camSize',
      MUSIC_SIZE: 'musicSize',
      BOOMBOX_SIZE: 'boomboxSize',
      LIGHTSHOW_SIZE: 'lightshowSize',
      ARCHIVE_DELAY: 'archiveDelay',
      ARCHIVE_SAVEDCLIPS: 'archiveSavedclips',
      ARCHIVE_SENTRYCLIPS: 'archiveSentryclips',
      ARCHIVE_TRACKMODECLIPS: 'archiveTrackmodeclips',
      ARCHIVE_RECENTCLIPS: 'archiveRecentclips',
      TESLA_EMAIL: 'teslaEmail',
      TESLA_PASSWORD: 'teslaPassword',
      TESLA_VIN: 'teslaVin',
      TESLAFI_BLE_VIN: 'teslafiBleVin',
      TESSIE_VIN: 'tessieVin',
      TESSIE_API_TOKEN: 'tessieApiToken',
      SENTRY_CASE: 'sentryCase',
      PUSHOVER_ENABLED: 'pushoverEnabled',
      PUSHOVER_USER_KEY: 'pushoverUserKey',
      PUSHOVER_APP_KEY: 'pushoverAppKey',
      GOTIFY_ENABLED: 'gotifyEnabled',
      GOTIFY_DOMAIN: 'gotifyDomain',
      GOTIFY_APP_TOKEN: 'gotifyAppToken',
      GOTIFY_PRIORITY: 'gotifyPriority',
      DISCORD_ENABLED: 'discordEnabled',
      DISCORD_WEBHOOK_URL: 'discordWebhookUrl',
      SLACK_ENABLED: 'slackEnabled',
      SLACK_WEBHOOK_URL: 'slackWebhookUrl',
      TELEGRAM_ENABLED: 'telegramEnabled',
      TELEGRAM_BOT_TOKEN: 'telegramBotToken',
      TELEGRAM_CHAT_ID: 'telegramChatId',
      NTFY_ENABLED: 'ntfyEnabled',
      NTFY_URL: 'ntfyUrl',
      TIME_ZONE: 'timeZone',
      NOTIFICATION_TITLE: 'notificationTitle',
      TESLAUSB_HOSTNAME: 'teslaUSBHostname',
      UPGRADE_PACKAGES: 'upgradePackages',
      INCREASE_ROOT_SIZE: 'increaseRootSize',
    };

    const result: Record<string, any> = {};

    for (const [envKey, configKey] of Object.entries(mapping)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        result[configKey] = this.parseTypedValue(envKey, value);
      }
    }

    return result;
  }

  /**
   * Load configuration from file (/root/teslausb_setup_variables.conf).
   * File is sourced as bash and parsed line by line.
   */
  private loadFromFile(): Record<string, any> {
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const result: Record<string, any> = {};

      // Parse lines like: export RSYNC_SERVER=backup.example.com
      const exportRegex = /^\s*export\s+(\w+)=(.*)$/gm;
      let match;

      while ((match = exportRegex.exec(content)) !== null) {
        const [, envKey, value] = match;
        // Map to config key using same logic as environment
        const configKey = this.envKeyToConfigKey(envKey);
        if (configKey) {
          const trimmedValue = value.replace(/^["']|["']$/g, '').trim();
          result[configKey] = this.parseTypedValue(envKey, trimmedValue);
        }
      }

      logger.debug({ path: this.configPath, keysLoaded: Object.keys(result).length }, 'Config file loaded');
      return result;
    } catch (error) {
      logger.warn({ path: this.configPath, error }, 'Failed to load config file');
      return {};
    }
  }

  private envKeyToConfigKey(envKey: string): string | null {
    const mapping: Record<string, string> = {
      ARCHIVE_SYSTEM: 'archiveSystem',
      RSYNC_SERVER: 'rsyncServer',
      RSYNC_USER: 'rsyncUser',
      RSYNC_PATH: 'rsyncPath',
      RCLONE_DRIVE: 'rcloneDrive',
      RCLONE_PATH: 'rclonePath',
      ARCHIVE_SERVER: 'archiveServer',
      SHARE_NAME: 'shareName',
      MUSIC_SHARE_NAME: 'musicShareName',
      SHARE_USER: 'shareUser',
      SHARE_PASSWORD: 'sharePassword',
      SHARE_DOMAIN: 'shareDomain',
      CAM_SIZE: 'camSize',
      MUSIC_SIZE: 'musicSize',
      BOOMBOX_SIZE: 'boomboxSize',
      LIGHTSHOW_SIZE: 'lightshowSize',
      ARCHIVE_DELAY: 'archiveDelay',
      ARCHIVE_SAVEDCLIPS: 'archiveSavedclips',
      ARCHIVE_SENTRYCLIPS: 'archiveSentryclips',
      ARCHIVE_TRACKMODECLIPS: 'archiveTrackmodeclips',
      ARCHIVE_RECENTCLIPS: 'archiveRecentclips',
      TESLA_EMAIL: 'teslaEmail',
      TESLA_PASSWORD: 'teslaPassword',
      TESLA_VIN: 'teslaVin',
      TESLAFI_BLE_VIN: 'teslafiBleVin',
      TESSIE_VIN: 'tessieVin',
      TESSIE_API_TOKEN: 'tessieApiToken',
      SENTRY_CASE: 'sentryCase',
      PUSHOVER_ENABLED: 'pushoverEnabled',
      PUSHOVER_USER_KEY: 'pushoverUserKey',
      PUSHOVER_APP_KEY: 'pushoverAppKey',
      GOTIFY_ENABLED: 'gotifyEnabled',
      GOTIFY_DOMAIN: 'gotifyDomain',
      GOTIFY_APP_TOKEN: 'gotifyAppToken',
      GOTIFY_PRIORITY: 'gotifyPriority',
      DISCORD_ENABLED: 'discordEnabled',
      DISCORD_WEBHOOK_URL: 'discordWebhookUrl',
      SLACK_ENABLED: 'slackEnabled',
      SLACK_WEBHOOK_URL: 'slackWebhookUrl',
      TELEGRAM_ENABLED: 'telegramEnabled',
      TELEGRAM_BOT_TOKEN: 'telegramBotToken',
      TELEGRAM_CHAT_ID: 'telegramChatId',
      NTFY_ENABLED: 'ntfyEnabled',
      NTFY_URL: 'ntfyUrl',
      TIME_ZONE: 'timeZone',
      NOTIFICATION_TITLE: 'notificationTitle',
      TESLAUSB_HOSTNAME: 'teslaUSBHostname',
      UPGRADE_PACKAGES: 'upgradePackages',
      INCREASE_ROOT_SIZE: 'increaseRootSize',
    };
    return mapping[envKey] || null;
  }

  private parseTypedValue(envKey: string, value: string): string | number | boolean {
    if (this.booleanEnvKeys.has(envKey)) {
      return value === 'true';
    }
    if (this.numericEnvKeys.has(envKey)) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return value;
  }

  /**
   * Remove sensitive data for logging
   */
  private sanitizeLogging(config: TeslaUSBConfig): Partial<TeslaUSBConfig> {
    const sanitized = { ...config };
    const sensitiveKeys = ['sharePassword', 'teslaPassword', 'pushoverUserKey', 'tessieApiToken'];
    for (const key of sensitiveKeys) {
      if (key in sanitized) {
        (sanitized as any)[key] = '***';
      }
    }
    return sanitized;
  }
}

export const configLoader = new ConfigLoader();
