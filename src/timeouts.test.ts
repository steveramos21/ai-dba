import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout, QueryTimeoutError } from "./timeouts.js";

describe("withTimeout (Task 1.3 portable fallback)", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when the promise wins the race", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "probe")).resolves.toBe(42);
  });

  it("propagates the promise's own rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "probe")).rejects.toThrow("boom");
  });

  it("rejects with QueryTimeoutError when the deadline passes first", async () => {
    const never = new Promise<never>(() => {});
    const err: any = await withTimeout(never, 25, "mysql query (e1)").catch((e) => e);
    expect(err).toBeInstanceOf(QueryTimeoutError);
    expect(err.name).toBe("QueryTimeoutError");
    expect(err.message).toContain("mysql query (e1)");
    expect(err.message).toContain("25ms");
  });

  it("clears its timer once the promise settles (no leaked timers)", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("ok"), 60_000, "probe")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
