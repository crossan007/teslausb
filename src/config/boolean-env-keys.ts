/**
 * Legacy lineage:
 * - setup/pi/envsetup.sh (boolean feature flags in shell environment)
 */
export const BOOLEAN_ENV_KEYS = new Set([
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
