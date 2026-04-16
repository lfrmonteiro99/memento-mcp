export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.WARN]: "WARN",
  [LogLevel.INFO]: "INFO",
  [LogLevel.DEBUG]: "DEBUG",
};

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(level: LogLevel = LogLevel.WARN): Logger {
  function log(msgLevel: LogLevel, msg: string): void {
    if (msgLevel <= level) {
      const prefix = `[memento-mcp] [${LEVEL_NAMES[msgLevel]}]`;
      process.stderr.write(`${prefix} ${msg}\n`);
    }
  }
  return {
    error: (msg) => log(LogLevel.ERROR, msg),
    warn: (msg) => log(LogLevel.WARN, msg),
    info: (msg) => log(LogLevel.INFO, msg),
    debug: (msg) => log(LogLevel.DEBUG, msg),
  };
}

export function logLevelFromEnv(): LogLevel {
  const val = process.env.MEMENTO_LOG_LEVEL?.toLowerCase();
  if (val === "error") return LogLevel.ERROR;
  if (val === "info") return LogLevel.INFO;
  if (val === "debug") return LogLevel.DEBUG;
  return LogLevel.WARN;
}
