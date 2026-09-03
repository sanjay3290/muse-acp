import { existsSync } from "node:fs";

const CANDIDATE_BINS = [
  process.env.MUSE_BIN,
  process.env.HOME ? `${process.env.HOME}/.local/bin/muse` : undefined,
  "/opt/homebrew/bin/muse",
  "/usr/local/bin/muse",
  "muse",
].filter(Boolean) as string[];

export function resolveMuseBin(): string {
  for (const bin of CANDIDATE_BINS) {
    if (bin === "muse") return bin;
    if (existsSync(bin)) return bin;
  }
  // Fallback — let spawn fail with a clear error
  return "muse";
}

/** Default for {@link resolveTurnIdleTimeoutMs}: ten minutes of silence. */
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 600_000;

/**
 * How long a turn may go with NO output from muse (no delta, no item event,
 * no approval traffic) before the adapter gives up on it and cancels.
 *
 * This is an inactivity watchdog, not a wall-clock budget: a turn that keeps
 * streaming text, opening tool calls, or asking for approvals runs as long as
 * it likes. `MUSE_TURN_IDLE_TIMEOUT_MS` overrides the default; `0` disables
 * the watchdog entirely. Anything unparseable falls back to the default.
 */
export function resolveTurnIdleTimeoutMs(): number {
  const raw = process.env.MUSE_TURN_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TURN_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TURN_IDLE_TIMEOUT_MS;
  return Math.floor(n);
}

export function resolveWorkspaceRoot(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return process.cwd();
}
