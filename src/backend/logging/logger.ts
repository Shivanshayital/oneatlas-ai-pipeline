// ============================================================================
// Logging Service
// ============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: string;
}

export class Logger {
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;
  private isProduction: boolean = process.env.NODE_ENV === "production";

  log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error // Explicit type for error
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      error: error?.stack,
    };

    this.logs.push(entry);

    // Keep only recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Console output
    if (!this.isProduction || level === "error") {
      const logFn = console[level] || console.log;
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
      logFn(prefix, message, context || "");
      if (error) logFn(error);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log("error", message, context, error);
  }

  getLogs(level?: LogLevel): LogEntry[] {
    if (!level) return this.logs;
    return this.logs.filter((log) => log.level === level);
  }

  clearLogs(): void {
    this.logs = [];
  }

  export(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}

export const logger = new Logger();
