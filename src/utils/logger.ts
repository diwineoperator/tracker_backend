/**
 * Minimal structured logger. Callers pass technical context only — never
 * request bodies, tokens, passwords or connection strings.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const isProd = process.env.NODE_ENV === 'production';

function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: isProd ? undefined : err.stack };
  }
  return { value: String(err) };
}

function write(level: Level, message: string, context?: Record<string, unknown>) {
  const entry = { time: new Date().toISOString(), level, message, ...context };
  const line = isProd
    ? JSON.stringify(entry)
    : `${entry.time} ${level.toUpperCase().padEnd(5)} ${message}${
        context ? ' ' + JSON.stringify(context) : ''
      }`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => {
    if (!isProd) write('debug', message, context);
  },
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, err?: unknown, context?: Record<string, unknown>) =>
    write('error', message, { ...context, error: err === undefined ? undefined : serialiseError(err) }),
};
