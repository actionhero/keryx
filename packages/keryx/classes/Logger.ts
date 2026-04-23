import type { configLogger } from "../config/logger";
import { ansi } from "../util/ansi";

export enum LogLevel {
  trace = "trace",
  debug = "debug",
  info = "info",
  warn = "warn",
  error = "error",
  fatal = "fatal",
}

export enum LogFormat {
  text = "text",
  json = "json",
}

/**
 * The Logger Class. Writes to stdout/stderr in either human-readable text format
 * (with optional ANSI colors) or structured NDJSON format for log aggregation systems.
 */
export class Logger {
  /** Minimum log level to output. Messages below this level are silently dropped. */
  level: LogLevel;
  /** Whether to apply ANSI color codes to the output (text format only). */
  colorize: boolean;
  /** Whether to prepend an ISO-8601 timestamp to each log line. */
  includeTimestamps: boolean;
  /** Indentation spaces used when JSON-stringifying the optional data argument in text mode. */
  jSONObjectParsePadding: number;
  /** When `true`, all logging is suppressed (used by CLI mode). */
  quiet: boolean;
  /** The output function — defaults to `console.log`. Override for custom transports. */
  outputStream: typeof console.log;
  /** Output format: `"text"` for human-readable colored output, `"json"` for structured NDJSON. */
  format: LogFormat;

  constructor(config: typeof configLogger) {
    this.level = config.level;
    this.colorize = config.colorize;
    this.includeTimestamps = config.includeTimestamps;
    this.jSONObjectParsePadding = 4;
    this.quiet = false;
    this.outputStream = console.log;
    this.format = config.format;
  }

  /**
   * Core logging method. Formats and writes a log line to `outputStream` if the given
   * level meets the minimum threshold.
   *
   * In text mode, outputs a human-readable string with optional timestamp, colors, and
   * pretty-printed data object. In JSON mode, outputs a single NDJSON line with structured
   * fields including `timestamp`, `level`, `message`, `pid`, and any fields from `data`.
   *
   * @param level - The severity level of this log entry.
   * @param message - The log message string.
   * @param data - Optional structured data to include. In text mode, JSON-stringified and
   *   appended to the log line. In JSON mode, merged into the output object.
   */
  log(level: LogLevel, message: string, data?: any) {
    if (this.quiet) return;

    if (
      Object.values(LogLevel).indexOf(level) <
      Object.values(LogLevel).indexOf(this.level)
    ) {
      return;
    }

    if (this.format === LogFormat.json) {
      this.logJson(level, message, data);
    } else {
      this.logText(level, message, data);
    }
  }

  /**
   * Log a trace message.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  trace(message: string, data?: any) {
    this.log(LogLevel.trace, message, data);
  }

  /**
   * Log a debug message.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  debug(message: string, data?: any) {
    this.log(LogLevel.debug, message, data);
  }

  /**
   * Log an info message.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  info(message: string, data?: any) {
    this.log(LogLevel.info, message, data);
  }

  /**
   * Log a warning.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  warn(message: string, data?: any) {
    this.log(LogLevel.warn, message, data);
  }

  /**
   * Log an error.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  error(message: string, data?: any) {
    this.log(LogLevel.error, message, data);
  }

  /**
   * Log a fatal error.
   * @param message - The message to log.
   * @param data - Optional structured data to include in the log entry.
   */
  fatal(message: string, data?: any) {
    this.log(LogLevel.fatal, message, data);
  }

  private logText(level: LogLevel, message: string, data?: any) {
    let timestamp = this.includeTimestamps ? `${new Date().toISOString()}` : "";
    if (this.colorize && timestamp.length > 0) {
      timestamp = ansi.gray(timestamp);
    }

    let formattedLevel = `[${level}]`;
    if (this.colorize) {
      formattedLevel = this.colorFromLogLevel(level)(formattedLevel);
    }

    let prettyObject =
      data !== undefined
        ? JSON.stringify(data, null, this.jSONObjectParsePadding)
        : "";
    if (this.colorize && prettyObject.length > 0) {
      prettyObject = ansi.cyan(prettyObject);
    }

    this.outputStream(
      `${timestamp} ${formattedLevel} ${message} ${prettyObject}`,
    );
  }

  private logJson(level: LogLevel, message: string, data?: any) {
    const entry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      pid: process.pid,
    };

    if (data !== undefined && data !== null) {
      if (typeof data === "object" && !Array.isArray(data)) {
        Object.assign(entry, data);
      } else {
        entry.data = data;
      }
    }

    this.outputStream(JSON.stringify(entry));
  }

  private colorFromLogLevel(level: LogLevel) {
    switch (level) {
      case LogLevel.trace:
        return ansi.gray;
      case LogLevel.debug:
        return ansi.blue;
      case LogLevel.info:
        return ansi.green;
      case LogLevel.warn:
        return ansi.yellow;
      case LogLevel.error:
        return ansi.red;
      case LogLevel.fatal:
        return ansi.magenta;
    }
  }
}
