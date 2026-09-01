/**
 * Logger — stderr only. Never writes to stdout (corrupts ACP JSON-RPC).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = (process.env.MUSE_ACP_LOG_LEVEL as LogLevel) ?? "warn";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const extra = meta ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[${ts}] [${level}] ${message}${extra}\n`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
