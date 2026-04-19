type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: Level = 'info';

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function shouldLog(level: Level): boolean {
  return order[level] >= order[currentLevel];
}

function format(level: Level, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const metaPart = meta !== undefined ? ` ${safeStringify(meta)}` : '';
  return `[${ts}] ${tag} ${message}${metaPart}`;
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) {
      return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    if (shouldLog('debug')) console.log(format('debug', message, meta));
  },
  info(message: string, meta?: unknown): void {
    if (shouldLog('info')) console.log(format('info', message, meta));
  },
  warn(message: string, meta?: unknown): void {
    if (shouldLog('warn')) console.warn(format('warn', message, meta));
  },
  error(message: string, meta?: unknown): void {
    if (shouldLog('error')) console.error(format('error', message, meta));
  },
};
