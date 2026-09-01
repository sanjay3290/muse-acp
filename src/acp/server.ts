/**
 * ACP Server — implements the Agent side of ACP.
 *
 * Handles: initialize, session/new, session/load, session/prompt,
 *          session/cancel, session/list, ext methods.
 * Delegates session lifecycle and turn execution to MspManager.
 */

import type { MspManager } from "../msp/manager.js";
import { contentBlocksToInput } from "../bridge/contentMap.js";
import type {
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  LoadSessionParams,
  PromptParams,
  CancelParams,
  PromptResult,
} from "./types.js";
import { ACP_ERROR_SESSION_NOT_FOUND } from "./types.js";
import { logger } from "../util/logger.js";

export interface AcpServerOptions {
  mspManager: MspManager;
  /** Called to send session/update notifications */
  onSessionUpdate: (sessionId: string, update: Record<string, unknown>) => void;
  /** Called to request permission from client */
  onRequestPermission?: (
    sessionId: string,
    toolCall: Record<string, unknown>,
    options: unknown[],
  ) => Promise<unknown>;
}

export class AcpServer {
  #msp: MspManager;
  #onSessionUpdate: (sessionId: string, update: Record<string, unknown>) => void;
  #onRequestPermission: AcpServerOptions["onRequestPermission"];
  #initialized = false;

  constructor(options: AcpServerOptions) {
    this.#msp = options.mspManager;
    this.#onSessionUpdate = options.onSessionUpdate;
    this.#onRequestPermission = options.onRequestPermission;
  }

  async handleRequest(
    method: string,
    params: Record<string, unknown> | undefined,
    _id: number | string | undefined,
  ): Promise<unknown> {
    logger.debug(`← ${method}`, params as Record<string, unknown>);

    switch (method) {
      case "initialize":
        return this.#handleInitialize(params as unknown as InitializeParams);
      case "session/new":
        return this.#handleNewSession(params as unknown as NewSessionParams);
      case "session/load":
        return this.#handleLoadSession(params as unknown as LoadSessionParams);
      case "session/prompt":
        return this.#handlePrompt(params as unknown as PromptParams);
      case "session/cancel":
        return this.#handleCancel(params as unknown as CancelParams);
      case "session/list":
        return this.#handleListSessions(params as Record<string, unknown> | undefined);
      case "session/set_mode":
        // Not yet mapped — acknowledge
        return {};
      case "session/set_model":
        return {};
      case "session/fork":
        throw Object.assign(new Error("session/fork not yet supported"), { code: -32601 });
      default:
        if (method.startsWith("ext/") || method.startsWith("mcp/")) {
          throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
        }
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  async handleNotification(method: string, _params: Record<string, unknown> | undefined): Promise<void> {
    if (method === "initialized") {
      logger.info("Client sent initialized notification");
      return;
    }
    if (method === "session/cancel") {
      // Some clients send cancel as notification
      const p = _params as unknown as CancelParams;
      if (p?.sessionId) await this.#handleCancel(p);
      return;
    }
    logger.debug(`Unhandled notification: ${method}`);
  }

  #handleInitialize(params: InitializeParams): InitializeResult {
    this.#initialized = true;
    const result: InitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        loadSession: true,
      },
      agentInfo: {
        name: "muse-acp",
        version: "0.1.0",
        title: "Muse ACP Adapter",
      },
    };
    logger.info("ACP initialize", { clientInfo: params.clientInfo, result });
    return result;
  }

  async #handleNewSession(params: NewSessionParams): Promise<{ sessionId: string }> {
    this.#ensureInitialized();
    const cwd = params.cwd ?? process.cwd();
    const session = await this.#msp.createSession(cwd);
    logger.info("Created session", { sessionId: session.sessionId, cwd });
    return { sessionId: session.sessionId };
  }

  async #handleLoadSession(params: LoadSessionParams): Promise<Record<string, unknown>> {
    this.#ensureInitialized();
    if (!params.sessionId) throw Object.assign(new Error("sessionId required"), { code: -32602 });
    // Try MSP resume — if not found, re-create
    try {
      await this.#msp.resumeSession(params.sessionId, params.cwd);
    } catch (e) {
      logger.warn("Failed to resume session, treating as new", { error: String(e) });
      // Fall through — session/new semantics
      const session = await this.#msp.createSession(params.cwd);
      return { sessionId: session.sessionId };
    }
    return {};
  }

  async #handleListSessions(
    _params: Record<string, unknown> | undefined,
  ): Promise<{ sessions: Array<{ sessionId: string; cwd: string }> }> {
    const sessions = this.#msp.listSessions();
    return {
      sessions: sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
    };
  }

  async #handlePrompt(params: PromptParams): Promise<PromptResult> {
    this.#ensureInitialized();
    const sessionId = params.sessionId;
    if (!sessionId) throw Object.assign(new Error("sessionId required"), { code: -32602 });
    if (!this.#msp.hasSession(sessionId)) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), {
        code: ACP_ERROR_SESSION_NOT_FOUND,
      });
    }

    const input = contentBlocksToInput(params.prompt ?? []);
    if (input.length === 0 || input.every((p) => !p.text?.trim())) {
      logger.warn("Empty prompt received", { sessionId });
      return { stopReason: "refusal" };
    }

    logger.info("Prompt received", { sessionId, textPreview: input.map((p) => p.text?.slice(0, 100)).join(" | ").slice(0, 200) });

    // Stream execution — bridge MSP turn iterator → ACP session/update
    const stopReason = await this.#msp.sendTurn(sessionId, input, {
      onSessionUpdate: (update) => this.#onSessionUpdate(sessionId, update as Record<string, unknown>),
      onRequestPermission: this.#onRequestPermission
        ? (toolCall, options) => this.#onRequestPermission!(sessionId, toolCall as Record<string, unknown>, options as unknown[])
        : undefined,
    });

    return { stopReason };
  }

  async #handleCancel(params: CancelParams): Promise<Record<string, unknown>> {
    if (!params.sessionId) return {};
    logger.info("Cancel requested", { sessionId: params.sessionId });
    await this.#msp.cancelTurn(params.sessionId);
    return {};
  }

  #ensureInitialized(): void {
    if (!this.#initialized) {
      logger.warn("Request before initialize — allowing anyway for lenient clients");
    }
  }
}
