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

/**
 * The model every NEW session starts on when the client names none.
 *
 * `MUSE_MODEL` (or `--model`, which sets it) is a catalog id such as
 * `muse-spark-1.3`. Unset means muse's own server default, which as of
 * 1.0.2 is the `-contributor` variant of the newest model — the one whose
 * catalog row says your content may be used for product improvement. A
 * client that wants the plain model pins it here, or picks it per session
 * through ACP's `model` config option.
 */
export function resolveDefaultModel(): string | undefined {
  const raw = process.env.MUSE_MODEL?.trim();
  return raw ? raw : undefined;
}

export function resolveWorkspaceRoot(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return process.cwd();
}
