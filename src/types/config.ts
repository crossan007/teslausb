import { z } from 'zod';

/**
 * Configuration schema for TeslaUSB.
 * Loaded from /root/teslausb_setup_variables.conf and validated at runtime.
 */
export const ArchiveSystemEnum = z.enum(['rsync', 'rclone', 'cifs', 'nfs', 'none']);

export const ConfigSchema = z.object({
  // Archive system selection
  archiveSystem: ArchiveSystemEnum.default('none'),

  // RSYNC backend
  rsyncServer: z.string().optional(),
  rsyncUser: z.string().optional(),
  rsyncPath: z.string().optional(),

  // Rclone backend
  rcloneDrive: z.string().optional(),
  rclonePath: z.string().optional(),

  // CIFS/NFS backend
  archiveServer: z.string().optional(),
  shareName: z.string().optional(),
  musicShareName: z.string().optional(),
  shareUser: z.string().optional(),
  sharePassword: z.string().optional(),
  shareDomain: z.string().optional(),

  // Snapshot & storage
  camSize: z.string().default('500'),
  musicSize: z.string().default('500'),
  boomboxSize: z.string().default('0'),
  lightshowSize: z.string().default('0'),

  // Archiving behavior
  archiveDelay: z.number().default(300),
  archiveSavedclips: z.boolean().default(true),
  archiveSentryclips: z.boolean().default(true),
  archiveTrackmodeclips: z.boolean().default(true),
  archiveRecentclips: z.boolean().default(false),
  triggerFileStartEnabled: z.boolean().default(false),
  triggerFileSaved: z.string().optional(),
  triggerFileSentry: z.string().optional(),
  triggerFileRecent: z.string().optional(),
  triggerFileAny: z.string().optional(),

  // Tesla API integration
  teslaEmail: z.string().optional(),
  teslaPassword: z.string().optional(),
  teslaVin: z.string().optional(),
  teslafiBleVin: z.string().optional(),
  tessieVin: z.string().optional(),
  tessieApiToken: z.string().optional(),
  sentryCase: z.number().optional(),

  // Notification providers
  pushoverEnabled: z.boolean().default(false),
  pushoverUserKey: z.string().optional(),
  pushoverAppKey: z.string().optional(),
  gotifyEnabled: z.boolean().default(false),
  gotifyDomain: z.string().optional(),
  gotifyAppToken: z.string().optional(),
  gotifyPriority: z.number().optional(),
  discordEnabled: z.boolean().default(false),
  discordWebhookUrl: z.string().optional(),
  slackEnabled: z.boolean().default(false),
  slackWebhookUrl: z.string().optional(),
  telegramEnabled: z.boolean().default(false),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  ntfyEnabled: z.boolean().default(false),
  ntfyUrl: z.string().optional(),

  // System
  timeZone: z.string().default('UTC'),
  notificationTitle: z.string().default('TeslaUSB'),
  teslaUSBHostname: z.string().default('teslausb'),

  // Web UI & API
  publicApiBaseUrl: z.string().optional(),
  publicWsUrl: z.string().optional(),
  uiCorsOrigins: z.string().default('*'),
  systemStatusDefaultGateway: z.string().default('192.168.1.1'),
  systemStatusPingPacketSize: z.number().default(1024),

  // Maintenance
  upgradePackages: z.boolean().default(false),
  increaseRootSize: z.string().default('0'),
});

export type TeslaUSBConfig = z.infer<typeof ConfigSchema>;
export type ArchiveSystem = z.infer<typeof ArchiveSystemEnum>;
