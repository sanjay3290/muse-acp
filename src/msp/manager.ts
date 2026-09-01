/**
 * MSP Manager — owns MuseClient lifecycle and per-session state.
 *
 * One MuseClient (one `muse serve` child) serves many ACP sessions
 * (many MSP sessions). This matches the SDK's design: MuseClient
 * multiplexes sessions over one Connection.
 */

import { MuseClient } from "../../vendor/muse-sdk/src/index.js";
import type { Session } from "../../vendor/muse-sdk/src/index.js";
import type { InitializeResult } from "../../vendor/msp-ts/msp.d.ts";
import { resolveMuseBin } from "../util/env.js";
import { logger } from "../util/logger.js";
import type { SessionUpdate } from "../acp/types.js";
import { itemToSessionUpdates, StreamingDedup } from "../bridge/streaming.js";
import type { MspInputBlock } from "../bridge/contentMap.js";

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  mspSession: Session<unknown>;
  activeTurnAbort?: AbortController;
  activeTurnId?: string;
}

export interface SendTurnOptions {
  onSessionUpdate: (update: SessionUpdate) => void;
  onRequestPermission?: (toolCall: unknown, options: unknown[]) => Promise<unknown>;
}

export class MspManager {
  #client: MuseClient | undefined;
  #initializeResult: InitializeResult | undefined;
  #sessions = new Map<string, SessionRecord>();
  #starting = false;
  // Per-session current permission handler — swapped per turn, read by the single onApproval
  #permissionHandlers = new Map<string, SendTurnOptions["onRequestPermission"]>();

  /** Ensure MuseClient is spawned and handshaken. Idempotent. */
  async ensureClient(): Promise<MuseClient> {
    if (this.#client) return this.#client;
    if (this.#starting) {
      // Wait for in-flight spawn
      while (this.#starting) {
        await new Promise((r) => setTimeout(r, 50));
        if (this.#client) return this.#client;
      }
      if (this.#client) return this.#client;
    }
    this.#starting = true;
    try {
      const museBin = resolveMuseBin();
      logger.info(`Spawning muse: ${museBin} serve`);
      const client = await MuseClient.spawn({
        museBin,
        args: ["serve"],
        clientInfo: { name: "muse_acp", version: "0.1.0", title: "Muse ACP Adapter" },
        capabilities: {},
        onStderr: (chunk) => logger.debug(`muse stderr: ${chunk.slice(0, 500)}`),
      });
      this.#client = client;
      this.#initializeResult = client.initializeResult;
      logger.info("Muse handshake complete", {
        serverInfo: this.#initializeResult.serverInfo,
        durability: client.durability,
      });
      return client;
    } finally {
      this.#starting = false;
    }
  }

  get initializeResult(): InitializeResult | undefined {
    return this.#initializeResult;
  }

  async createSession(cwd: string): Promise<SessionRecord> {
    const client = await this.ensureClient();
    const mspSession = await client.startSession({ workspaceRoot: cwd });
    const record: SessionRecord = {
      sessionId: mspSession.sessionId,
      cwd,
      mspSession,
    };
    this.#sessions.set(mspSession.sessionId, record);
    this.#setupApprovalRouting(record);
    return record;
  }

  async resumeSession(sessionId: string, cwd?: string): Promise<SessionRecord> {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const client = await this.ensureClient();
    const mspSession = await client.resumeSession({ sessionId, history: "auto" });
    const record: SessionRecord = {
      sessionId: mspSession.sessionId,
      cwd: cwd ?? process.cwd(),
      mspSession,
    };
    this.#sessions.set(mspSession.sessionId, record);
    this.#setupApprovalRouting(record);
    return record;
  }

  #setupApprovalRouting(record: SessionRecord): void {
    // Register once per session — onApproval replaces, so re-registering per turn is wasteful
    // and hides the fact that approvals can arrive outside the current turn's window.
    record.mspSession.onApproval(async (req) => {
      const handler = this.#permissionHandlers.get(record.sessionId);
      logger.info("Approval requested", { approvalId: req.approvalId, toolName: req.toolName, sessionId: record.sessionId });
      if (!handler) {
        // No handler for this session's current turn — deny by default
        const deny = req.availableChoices.find((c) => typeof c.decision === "string" && c.decision.startsWith("denied"));
        return { choiceId: deny?.choiceId ?? req.availableChoices[0]?.choiceId ?? "" };
      }
      try {
        const result = (await handler(
          {
            toolCallId: req.toolCallId,
            title: req.toolName,
            kind: "execute",
            status: "pending",
            rawInput: req.rawArgs,
          },
          req.availableChoices.map((c) => ({
            optionId: c.choiceId,
            name: c.label,
            kind: typeof c.decision === "string" && c.decision.startsWith("approved") ? "allow" : "reject",
          })),
        )) as { outcome?: { optionId?: string }; optionId?: string } | undefined;
        const optionId =
          (result as { outcome?: { optionId?: string } })?.outcome?.optionId ??
          (result as { optionId?: string })?.optionId ??
          req.availableChoices[0]?.choiceId ??
          "";
        logger.info("Approval decided", { approvalId: req.approvalId, choiceId: optionId });
        return { choiceId: optionId };
      } catch (e) {
        logger.warn("Permission request failed, denying", { error: String(e) });
        const deny = req.availableChoices.find((c) => typeof c.decision === "string" && c.decision.startsWith("denied"));
        return { choiceId: deny?.choiceId ?? req.availableChoices[0]?.choiceId ?? "" };
      }
    });
    record.mspSession.onApprovalError((failure) => {
      logger.warn("Approval failure", failure as unknown as Record<string, unknown>);
    });
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  listSessions(): SessionRecord[] {
    return [...this.#sessions.values()];
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * Send a turn and stream results via onSessionUpdate.
   * Returns stopReason for PromptResponse.
   */
  async sendTurn(
    sessionId: string,
    input: MspInputBlock[],
    options: SendTurnOptions,
  ): Promise<"end_turn" | "cancelled" | "failed"> {
    const record = this.#sessions.get(sessionId);
    if (!record) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: -32002 });

    const session = record.mspSession;

    // Swap in this turn's permission handler — the single onApproval registered at
    // session creation will delegate to it. Clear on turn end.
    if (options.onRequestPermission) {
      this.#permissionHandlers.set(sessionId, options.onRequestPermission);
    } else {
      this.#permissionHandlers.delete(sessionId);
    }

    const abort = new AbortController();
    record.activeTurnAbort = abort;

    // Submit turn — returns Turn with .turnId, .completed, .items(), .deltas()
    let turn: { turnId: string; completed: Promise<unknown>; items(): AsyncIterable<unknown>; deltas(): AsyncIterable<unknown> };
    try {
      turn = (await session.sendUserTurn({ input })) as unknown as typeof turn;
      record.activeTurnId = turn.turnId;
    } catch (e) {
      record.activeTurnAbort = undefined;
      logger.error("sendUserTurn failed", { error: String(e) });
      const msg = e instanceof Error ? e.message : String(e);
      options.onSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n[Error sending turn: ${msg}]\n` },
      });
      return "failed";
    }

    const dedup = new StreamingDedup();
    logger.info("Turn started", { sessionId, turnId: turn.turnId });

    try {
      // Start streaming first so that turn/started and early deltas are not missed,
      // but don't let a stuck stream block the response — completion is the source of truth.
      const streaming = this.#streamViaTurn(turn, options.onSessionUpdate, dedup, abort.signal);
      // Safety timeout: tool turns should complete in well under 5m; if turn.completed
      // never settles (raced iterators, lost routing), don't hang the ACP response forever.
      const outcome = await Promise.race([
        this.#waitForCompleted(turn.completed, abort.signal),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("turn timeout after 120s")), 120_000),
        ),
      ]).catch((e) => {
        if ((e as Error).message.includes("turn timeout")) {
          logger.error("Turn timed out — returning failed to unblock ACP", { sessionId, turnId: turn.turnId });
          // Tell muse to drop it too. Without this the host keeps waiting on a
          // turn the ACP client has already been told failed, and the next
          // prompt on this session queues behind a turn nobody will finish.
          void this.cancelTurn(sessionId).catch(() => {});
          return { kind: "completed", params: { terminal: "failed" } } as unknown;
        }
        throw e;
      });

      // Now that the terminal is known, give streaming a short drain window then abort.
      // Abortable iteration above ensures `abort` actually breaks a stuck `next()`.
      abort.abort();
      await Promise.race([
        streaming,
        new Promise<void>((r) => setTimeout(r, 500)),
      ]).catch(() => {});

      logger.info("Turn outcome", { sessionId, outcomeKind: (outcome as { kind?: string })?.kind });

      const outcomeKind = (outcome as { kind?: string })?.kind;
      if (outcomeKind === "cancelled") return "cancelled";
      if (outcomeKind === "terminalUnknown") return "failed";
      if (outcomeKind === "unqueued") return "cancelled";
      if (outcomeKind === "completed") {
        const terminal = (outcome as { params?: { terminal?: string } })?.params?.terminal;
        if (terminal === "cancelled") return "cancelled";
        if (terminal === "failed") return "failed";
        return "end_turn";
      }
      // Fallback: if abort was signalled but outcome is something else, still treat as cancelled
      if (abort.signal.aborted) return "cancelled";
      return "end_turn";
    } catch (e) {
      if (abort.signal.aborted) return "cancelled";
      logger.error("Turn streaming error", { error: String(e) });
      return "failed";
    } finally {
      record.activeTurnAbort = undefined;
      record.activeTurnId = undefined;
      this.#permissionHandlers.delete(sessionId);
    }
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    const turnId = record.activeTurnId;
    // Signal local abort first so streaming stops relaying
    record.activeTurnAbort?.abort();
    logger.info("Turn cancelled", { sessionId, turnId });
    // Tell the host to actually stop — otherwise muse keeps burning tokens
    if (turnId && this.#client) {
      try {
        await (this.#client as unknown as { connection: { command: (m: string, p: unknown) => Promise<unknown> } }).connection.command(
          "turn/cancel",
          { sessionId, turnId },
        );
        logger.info("MSP turn/cancel sent", { sessionId, turnId });
      } catch (e) {
        // Fallback to turn/interrupt if cancel is not available, or just log
        logger.warn("turn/cancel failed, trying turn/interrupt", { error: String(e) });
        try {
          await (this.#client as unknown as { connection: { command: (m: string, p: unknown) => Promise<unknown> } }).connection.command(
            "turn/interrupt",
            { sessionId, turnId },
          );
        } catch (e2) {
          logger.warn("turn/interrupt also failed", { error: String(e2) });
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    // Abort all active turns
    for (const record of this.#sessions.values()) {
      record.activeTurnAbort?.abort();
    }
    this.#permissionHandlers.clear();
    if (this.#client) {
      try {
        await this.#client.close();
      } catch (e) {
        logger.warn("Error closing MuseClient", { error: String(e) });
      }
      this.#client = undefined;
    }
    this.#sessions.clear();
  }

  // ── private ─────────────────────────────────────────────────────────────

  async #streamViaTurn(
    turn: { items(): AsyncIterable<unknown>; deltas(): AsyncIterable<unknown> },
    onUpdate: (update: SessionUpdate) => void,
    dedup: StreamingDedup,
    signal: AbortSignal,
  ): Promise<void> {
    // Use abortable iteration so that `abort` can break a `for await` waiting on `next()`
    // — otherwise `if (signal.aborted) break` inside the body never runs when stuck in `next()`.
    const abortable = async function* <T>(iterable: AsyncIterable<T>, sig: AbortSignal): AsyncIterable<T> {
      const iter = iterable[Symbol.asyncIterator]();
      while (true) {
        if (sig.aborted) break;
        const nextP = iter.next();
        const abortP = new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          sig.addEventListener("abort", onAbort, { once: true });
          // Also handle already-aborted case
          if (sig.aborted) reject(new Error("aborted"));
        });
        let result: IteratorResult<T>;
        try {
          result = await Promise.race([nextP, abortP]);
        } catch (e) {
          if ((e as Error).message === "aborted" || sig.aborted) break;
          throw e;
        }
        if (result.done) break;
        yield result.value;
      }
      try {
        await iter.return?.();
      } catch {}
    };

    const tasks: Promise<void>[] = [];

    tasks.push(
      (async () => {
        try {
          for await (const delta of abortable(turn.deltas() as AsyncIterable<unknown>, signal) as AsyncIterable<{ itemId?: string; delta?: string; field?: string }>) {
            const d = delta as { itemId?: string; delta?: string; field?: string };
            if (d.field === "text" && typeof d.delta === "string" && d.itemId) {
              dedup.recordDelta(d.itemId, d.delta);
              onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: d.delta } });
            } else if (typeof d.delta === "string") {
              onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: d.delta } });
            }
          }
        } catch (e) {
          if (!signal.aborted) logger.warn("Delta iterator error", { error: String(e) });
        }
      })(),
    );

    tasks.push(
      (async () => {
        try {
          for await (const rawItem of abortable(turn.items() as AsyncIterable<unknown>, signal) as AsyncIterable<{ itemId: string; kind: string; status: string; text?: string; turnId: string; toolName?: string; toolCallId?: string; tool?: string; callId?: string; visibleOutput?: string }>) {
            const item = rawItem as { itemId: string; kind: string; status: string; text?: string; turnId: string; toolName?: string; toolCallId?: string; tool?: string; callId?: string; visibleOutput?: string };
            if (item.kind === "agentMessage" && item.status === "completed" && dedup.wasFullyStreamed(item as never)) {
              continue;
            }
            const updates = itemToSessionUpdates(item as never);
            for (const u of updates) onUpdate(u);
          }
        } catch (e) {
          if (!signal.aborted) logger.warn("Item iterator error", { error: String(e) });
        }
      })(),
    );

    await Promise.all(tasks);
  }

  async #waitForCompleted(completed: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return { kind: "cancelled" } as unknown;
    return Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    ]).catch((e) => {
      if ((e as Error).message === "cancelled" || signal.aborted) return { kind: "cancelled" } as unknown;
      throw e;
    });
  }
}
