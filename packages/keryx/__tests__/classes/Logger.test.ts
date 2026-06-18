import { describe, expect, test } from "bun:test";
import { LogFormat, Logger, LogLevel } from "../../classes/Logger";

function createLogger(
  overrides: Partial<{
    level: LogLevel;
    includeTimestamps: boolean;
    colorize: boolean;
    format: LogFormat;
    maxParamLength: number;
  }> = {},
) {
  return new Logger({
    level: LogLevel.trace,
    includeTimestamps: true,
    colorize: false,
    format: LogFormat.text,
    maxParamLength: 100,
    ...overrides,
  });
}

function capture(logger: Logger): string[] {
  const lines: string[] = [];
  logger.outputStream = (...args: any[]) => lines.push(args.join(" "));
  return lines;
}

describe("Logger", () => {
  describe("text format", () => {
    test("outputs formatted text with timestamp and level", () => {
      const logger = createLogger();
      const lines = capture(logger);

      logger.info("hello world");

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[info]");
      expect(lines[0]).toContain("hello world");
      // ISO timestamp pattern
      expect(lines[0]).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    test("outputs without timestamp when disabled", () => {
      const logger = createLogger({ includeTimestamps: false });
      const lines = capture(logger);

      logger.info("no timestamp");

      expect(lines[0]).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(lines[0]).toContain("[info]");
      expect(lines[0]).toContain("no timestamp");
    });

    test("includes data as pretty-printed JSON", () => {
      const logger = createLogger();
      const lines = capture(logger);

      logger.info("with data", { key: "value" });

      expect(lines[0]).toContain('"key"');
      expect(lines[0]).toContain('"value"');
    });
  });

  describe("json format", () => {
    test("outputs valid NDJSON", () => {
      const logger = createLogger({ format: LogFormat.json });
      const lines = capture(logger);

      logger.info("hello world");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("hello world");
      expect(parsed.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(parsed.pid).toBe(process.pid);
    });

    test("merges structured data fields into the JSON output", () => {
      const logger = createLogger({ format: LogFormat.json });
      const lines = capture(logger);

      logger.info("action completed", {
        action: "user:create",
        duration: 42,
        status: "OK",
      });

      const parsed = JSON.parse(lines[0]);
      expect(parsed.message).toBe("action completed");
      expect(parsed.action).toBe("user:create");
      expect(parsed.duration).toBe(42);
      expect(parsed.status).toBe("OK");
    });

    test("applies ANSI color codes when colorize is enabled", () => {
      const logger = createLogger({ colorize: true });
      const lines = capture(logger);

      logger.info("colored");

      expect(lines[0]).toContain("\x1b[");
    });

    test("does not include ANSI color codes", () => {
      const logger = createLogger({
        format: LogFormat.json,
        colorize: true,
      });
      const lines = capture(logger);

      logger.error("something broke", { detail: "test" });

      // ANSI escape codes start with \x1b[
      expect(lines[0]).not.toContain("\x1b[");
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe("error");
    });
  });

  describe("log level filtering", () => {
    test("drops messages below the configured level", () => {
      const logger = createLogger({ level: LogLevel.warn });
      const lines = capture(logger);

      logger.trace("dropped");
      logger.debug("dropped");
      logger.info("dropped");
      logger.warn("kept");
      logger.error("kept");

      expect(lines).toHaveLength(2);
    });

    test("drops messages below the configured level in JSON mode", () => {
      const logger = createLogger({
        level: LogLevel.warn,
        format: LogFormat.json,
      });
      const lines = capture(logger);

      logger.trace("dropped");
      logger.debug("dropped");
      logger.info("dropped");
      logger.warn("kept");
      logger.error("kept");

      expect(lines).toHaveLength(2);
    });
  });

  describe("quiet mode", () => {
    test("suppresses all output when quiet is true", () => {
      const logger = createLogger();
      logger.quiet = true;
      const lines = capture(logger);

      logger.info("should not appear");
      logger.error("also silent");

      expect(lines).toHaveLength(0);
    });

    test("suppresses all output in JSON mode when quiet is true", () => {
      const logger = createLogger({ format: LogFormat.json });
      logger.quiet = true;
      const lines = capture(logger);

      logger.info("should not appear");

      expect(lines).toHaveLength(0);
    });
  });

  describe("convenience methods", () => {
    test("each level method calls log with the correct level", () => {
      const logger = createLogger({ format: LogFormat.json });
      const lines = capture(logger);

      logger.trace("t");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      logger.fatal("f");

      const levels = lines.map((l) => JSON.parse(l).level);
      expect(levels).toEqual([
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
      ]);
    });
  });
});
