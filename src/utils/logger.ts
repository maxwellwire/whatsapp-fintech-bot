import { env } from '../config/env.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const levels: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const current = levels[env.LOG_LEVEL] ?? 2;

function fmt(level: LogLevel, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (meta === undefined) return base;
  return `${base} ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
}

export const logger = {
  error(message: string, meta?: unknown) {
    if (current >= levels.error) console.error(fmt('error', message, meta));
  },
  warn(message: string, meta?: unknown) {
    if (current >= levels.warn) console.warn(fmt('warn', message, meta));
  },
  info(message: string, meta?: unknown) {
    if (current >= levels.info) console.info(fmt('info', message, meta));
  },
  debug(message: string, meta?: unknown) {
    if (current >= levels.debug) console.debug(fmt('debug', message, meta));
  },
};