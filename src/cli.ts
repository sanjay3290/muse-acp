#!/usr/bin/env node
/**
 * muse-acp CLI — ACP stdio entry point.
 *
 * Usage:
 *   muse-acp                          # ACP over stdio (default)
 *   muse-acp --muse-bin /path/to/muse # custom binary
 *   muse-acp --help
 */

import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { registerAgent } from "./acp/agent.js";
import { MspManager } from "./msp/manager.js";
import { logger, setLogLevel } from "./util/logger.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(`muse-acp v${VERSION} — ACP adapter for Muse Code

Usage:
  muse-acp [options]

Options:
  --muse-bin <path>     Path to muse binary (default: auto-detected)
  --log-level <level>   Log level: debug, info, warn, error (default: warn)
                        Logs go to stderr only.
  --help, -h            Show this help
  --version, -v         Show version

Environment:
  MUSE_BIN              Override muse binary path
  MUSE_TURN_IDLE_TIMEOUT_MS
                        Cancel a turn after this much silence from muse
                        (default 600000 = 10 min; 0 disables). Resets on every
                        delta, item event, and approval; long turns are fine.
  MUSE_ACP_LOG_LEVEL    Override log level

Protocol:
  Speaks Agent Client Protocol (ACP) v1 over stdio (NDJSON JSON-RPC 2.0).
  Pairs with any ACP client (e.g. Zed, ACP-compatible editors).

  ACP methods handled:
    initialize, session/new, session/load, session/prompt,
    session/cancel, session/list

  MSP (Muse Session Protocol) is used internally via @muse-code/sdk
  to drive a \`muse serve\` child process.

`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  // Parse options
  let museBin: string | undefined;
  let logLevel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--muse-bin" && args[i + 1]) {
      museBin = args[++i];
    } else if (args[i] === "--log-level" && args[i + 1]) {
      logLevel = args[++i];
    } else if (args[i]?.startsWith("--muse-bin=")) {
      museBin = args[i].split("=")[1];
    } else if (args[i]?.startsWith("--log-level=")) {
      logLevel = args[i].split("=")[1] as string;
    }
  }

  if (museBin) process.env.MUSE_BIN = museBin;
  if (logLevel) {
    process.env.MUSE_ACP_LOG_LEVEL = logLevel;
    setLogLevel(logLevel as never);
  }

  // Ensure stdout is only used for ACP JSON-RPC
  // All logging must go to stderr (logger does this by default)

  const mspManager = new MspManager();

  // stdout carries ACP JSON-RPC and nothing else; the logger writes to stderr.
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const connection = registerAgent(agent({ name: "muse-acp" }), mspManager).connect(stream);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    connection.close();
    await mspManager.shutdown().catch((e: unknown) => {
      logger.warn("Shutdown error", { error: String(e) });
    });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(`muse-acp v${VERSION} starting — ACP over stdio`);

  try {
    // Resolves when the client closes stdin or the connection errors.
    await connection.closed;
  } finally {
    await mspManager.shutdown().catch(() => {});
  }
}

main().catch((e) => {
  logger.error("Fatal", { error: String(e) });
  process.exit(1);
});
