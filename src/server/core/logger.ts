import pino from 'pino';

/**
 * Structured logger using pino.
 * Outputs JSON to stdout (for systemd journal or log aggregation).
 * Pretty-prints in development via environment check.
 */
const isDev = process.env.NODE_ENV === 'development';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          singleLine: false,
        },
      }
    : undefined,
});

export default logger;
