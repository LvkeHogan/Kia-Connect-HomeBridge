/**
 * HomeBridge platform name — must match pluginAlias in config.schema.json
 */
export const PLATFORM_NAME = 'KiaConnect';

/**
 * npm package name — must match the "name" field in package.json
 */
export const PLUGIN_NAME = 'homebridge-kia-connect';

/**
 * How long after executing a remote command (lock/unlock/climate) we wait before
 * polling for a status update to confirm the command took effect.
 */
export const POST_COMMAND_REFRESH_DELAY_MS = 35_000; // 35 seconds

/**
 * Minimum time between status refreshes regardless of what is requested.
 * Prevents multiple rapid polls from stacking up.
 */
export const MIN_REFRESH_INTERVAL_MS = 60_000; // 1 minute

/**
 * Known daily API call limits by region (community-documented).
 * Kia Connect (US): ~30 calls/day
 * Kia Connect (EU): ~200 calls/day
 * CA: unknown but conservative; must wait 90s between vehicle commands
 */
export const DAILY_LIMITS: Record<string, number> = {
  US: 30,
  CA: 30,  // conservative
  EU: 200,
  AU: 200, // conservative
};

/**
 * Warn the user when daily call count reaches this fraction of the limit.
 */
export const DAILY_LIMIT_WARN_FRACTION = 0.8;
