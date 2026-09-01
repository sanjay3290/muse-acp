#!/usr/bin/env node
/**
 * muse-acp CLI — ACP stdio entry point.
 *
 * Usage:
 *   muse-acp                          # ACP over stdio (default)
 *   muse-acp --muse-bin /path/to/muse # custom binary
 *   muse-acp --help
 */

import { AcpProtocol } from "./acp/protocol.js";
import { AcpServer } from "./acp/server.js";
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

  // Wire ACP protocol
  let protocol: AcpProtocol;

  const server = new AcpServer({
    mspManager,
    onSessionUpdate: (sessionId, update) => {
      protocol.notify("session/update", { sessionId, update });
    },
    onRequestPermission: async (sessionId, toolCall, options) => {
      try {
        const result = await protocol.request("session/request_permission", {
          sessionId,
          toolCall,
          options,
        } as unknown as Record<string, unknown>);
        return result;
      } catch (e) {
        logger.warn("session/request_permission failed", { error: String(e) });
        throw e;
      }
    },
  });

  protocol = new AcpProtocol(async (method, params, id) => {
    // Notifications have no id
    if (id === undefined) {
      await server.handleNotification(method, params);
      return undefined;
    }
    return server.handleRequest(method, params, id);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await mspManager.shutdown();
    } catch (e) {
      logger.warn("Shutdown error", { error: String(e) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(`muse-acp v${VERSION} starting — ACP over stdio`);

  try {
    await protocol.listen();
  } catch (e) {
    logger.error("Protocol error", { error: String(e) });
  } finally {
    await mspManager.shutdown().catch(() => {});
  }
}

main().catch((e) => {
  logger.error("Fatal", { error: String(e) });
  process.exit(1);
});
