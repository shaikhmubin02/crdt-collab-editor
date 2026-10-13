export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON-lines logger. */
export function jsonLogger(minLevel: Level = 'info'): Logger {
  return {
    log(level, msg, fields) {
      if (ORDER[level] < ORDER[minLevel]) return;
      const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
      if (ORDER[level] >= ORDER.warn) process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    },
  };
}

export const silentLogger: Logger = { log: () => undefined };
