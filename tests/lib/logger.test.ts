import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogLevel } from "../../src/lib/logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => { stderrSpy.mockRestore(); });

  it("logs error at warn level", () => {
    const log = createLogger(LogLevel.WARN);
    log.error("test error");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ERROR] test error")
    );
  });

  it("suppresses debug at warn level", () => {
    const log = createLogger(LogLevel.WARN);
    log.debug("hidden");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("logs debug at debug level", () => {
    const log = createLogger(LogLevel.DEBUG);
    log.debug("visible");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEBUG] visible")
    );
  });

  it("never writes to stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger(LogLevel.DEBUG);
    log.error("err");
    log.warn("warn");
    log.info("info");
    log.debug("debug");
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
