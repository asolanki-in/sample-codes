/**
 * Tiny dependency-free structured logger.
 *
 * Logs go to stderr so they never corrupt stdout (which we keep clean for
 * machine-readable output such as the final JSON report).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

const useColor = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope?: string,
  ) {}

  child(scope: string): Logger {
    const next = this.scope ? `${this.scope}:${scope}` : scope;
    return new Logger(this.level, next);
  }

  debug(message: string, meta?: unknown): void {
    this.log("debug", message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.log("info", message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.log("warn", message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.log("error", message, meta);
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const scope = this.scope ? ` [${this.scope}]` : "";
    const head = useColor
      ? `${COLORS[level]}${ts} ${tag}${RESET}${scope}`
      : `${ts} ${tag}${scope}`;

    let line = `${head} ${message}`;
    if (meta !== undefined) {
      line += ` ${safeStringify(meta)}`;
    }
    process.stderr.write(line + "\n");
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_k, v) => (v instanceof Error ? serializeError(v) : v));
  } catch {
    return String(value);
  }
}

function serializeError(err: Error): Record<string, unknown> {
  return { name: err.name, message: err.message, stack: err.stack };
}

export function createLogger(level: LogLevel = "info", scope?: string): Logger {
  return new Logger(level, scope);
}
