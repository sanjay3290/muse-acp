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

export function resolveWorkspaceRoot(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return process.cwd();
}
