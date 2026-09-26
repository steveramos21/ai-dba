/**
 * Sprint 10 Part 2a — portable query-timeout fallback (Task 1.3).
 *
 * Engine-native timeout mechanisms (statement_timeout, requestTimeout,
 * callTimeout, maxTimeMS) are configured per connector; this race is the
 * portable backstop for what they cannot cover (e.g. a wedged socket where
 * the server never sends its own interruption).
 *
 * Call sites that race a promise which can settle after the timeout has been
 * surfaced keep a `.catch(() => {})` guard on that promise as belt-and-braces:
 * Promise.race already observes both racers (a late rejection is not an
 * unhandled rejection), but the guards keep the intent explicit — keep them.
 */

export class QueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTimeoutError";
  }
}

/**
 * Await `promise`, rejecting with QueryTimeoutError if it settles later than
 * `ms` milliseconds. The timer is always cleared, so a promise that settles on
 * time never leaves a live timer behind.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new QueryTimeoutError(`${label} exceeded its ${ms}ms query timeout`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
