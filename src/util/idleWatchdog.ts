/**
 * A resettable inactivity timer.
 *
 * `expired` rejects with {@link IdleTimeout} once `timeoutMs` passes with no
 * `touch()`. Every `touch()` restarts the countdown. A `timeoutMs` of `0`
 * disables the watchdog: `expired` then never settles. Call `dispose()` when
 * the guarded work finishes so the timer does not keep the process alive.
 */
export class IdleTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no activity for ${timeoutMs / 1000}s`);
    this.name = "IdleTimeout";
  }
}

export class IdleWatchdog {
  readonly expired: Promise<never>;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reject: ((e: IdleTimeout) => void) | undefined;
  #done = false;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    this.expired = new Promise<never>((_, reject) => {
      this.#reject = reject;
    });
    // A rejection nobody has raced yet must not surface as unhandled.
    this.expired.catch(() => {});
    this.#arm();
  }

  get enabled(): boolean {
    return this.#timeoutMs > 0;
  }

  /** Record activity: the countdown starts over. */
  touch(): void {
    if (this.#done) return;
    this.#arm();
  }

  /** Stop the watchdog for good; `expired` will never settle after this. */
  dispose(): void {
    this.#done = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#timeoutMs <= 0) return;
    this.#timer = setTimeout(() => {
      this.#done = true;
      this.#reject?.(new IdleTimeout(this.#timeoutMs));
    }, this.#timeoutMs);
  }
}
