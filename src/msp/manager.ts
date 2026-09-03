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
import { resolveMuseBin, resolveTurnIdleTimeoutMs } from "../util/env.js";
import { IdleTimeout, IdleWatchdog } from "../util/idleWatchdog.js";
import { logger } from "../util/logger.js";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  SessionUpdate,
  RequestPermissionResponse,
  ToolCallUpdate,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import { deltaToSessionUpdates, itemToSessionUpdates, StreamingDedup, ToolOutputAccumulator, toolToAcpKind } from "../bridge/streaming.js";
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
  onRequestPermission?: (
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
  ) => Promise<RequestPermissionResponse>;
}

/**
 * A turn is abandoned only when muse goes silent, never for running long.
 *
 * A net, not a policy: every hang this has ever caught was a bug, and the
 * point is to hand the client a real error instead of a request that never
 * answers. The first cut was a fixed 120s wall clock, which also cancelled
 * perfectly healthy turns that happened to run a long build or read a lot of
 * files. The watchdog now resets on every delta, item event, and approval
 * round trip (see {@link resolveTurnIdleTimeoutMs} for the knob). ACP has no
 * "failed" stop reason — the vocabulary is `end_turn`, `max_tokens`,
 * `max_turn_requests`, `refusal`, `cancelled` — so a turn that dies rejects
 * `session/prompt` rather than resolving it with a stop reason the schema
 * does not carry.
 */

/** An MSP choice, as much of it as the mapping below reads. */
interface MspChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope?: string;
}

/**
 * MSP's `decision` + `scope` → ACP's `PermissionOptionKind`.
 *
 * ACP's vocabulary is four values — `allow_once`, `allow_always`,
 * `reject_once`, `reject_always` — and it encodes PERSISTENCE as well as
 * polarity. MSP splits the same two facts across `decision` (`approved…` /
 * `denied…` / `abort`) and `scope` (`once` / `session` / `localPersistent`),
 * so both are read. A scope that outlives the single call is "always".
 */
function permissionOptionKind(choice: MspChoice): PermissionOption["kind"] {
  const allow = choice.decision.startsWith("approved");
  const always = choice.scope === "session" || choice.scope === "localPersistent";
  if (allow) return always ? "allow_always" : "allow_once";
  return always ? "reject_always" : "reject_once";
}

/**
 * The choice to take when nobody chose: an explicit denial if the host offers
 * one, else the first choice. Never a silent approval.
 */
function denyChoice(choices: readonly MspChoice[]): string {
  const deny = choices.find((c) => c.decision.startsWith("denied") || c.decision === "abort");
  return deny?.choiceId ?? choices[0]?.choiceId ?? "";
}

/** `rawArgs` is a JSON string on the wire; ACP's `rawInput` wants the object. */
function safeJsonParse(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class MspManager {
  #client: MuseClient | undefined;
  #initializeResult: InitializeResult | undefined;
  #sessions = new Map<string, SessionRecord>();
  #starting = false;
  // Per-session current permission handler — swapped per turn, read by the single onApproval
  #permissionHandlers = new Map<string, SendTurnOptions["onRequestPermission"]>();
  /** Per-session activity hooks; an approval round trip counts as the turn being alive. */
  #activity = new Map<string, () => void>();

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
      if (!handler) return { choiceId: denyChoice(req.availableChoices) };
      this.#activity.get(record.sessionId)?.();
      try {
        const result = await handler(
          {
            // The approval names the toolCall ITEM; that id is what the client
            // already holds from `tool_call`, so the permission prompt attaches
            // to the right row instead of an orphan.
            toolCallId: req.itemId,
            title: req.toolName,
            kind: toolToAcpKind(req.toolName),
            status: "pending",
            rawInput: safeJsonParse(req.rawArgs),
          },
          req.availableChoices.map((c) => ({
            optionId: c.choiceId,
            name: c.label,
            kind: permissionOptionKind(c),
          })),
        );
        // A client that cancels the turn answers `cancelled` rather than
        // picking. Denying is the only safe reading of "no choice was made".
        if (result.outcome.outcome !== "selected") {
          logger.info("Permission request cancelled by client", { approvalId: req.approvalId });
          return { choiceId: denyChoice(req.availableChoices) };
        }
        logger.info("Approval decided", { approvalId: req.approvalId, choiceId: result.outcome.optionId });
        return { choiceId: result.outcome.optionId };
      } catch (e) {
        logger.warn("Permission request failed, denying", { error: String(e) });
        return { choiceId: denyChoice(req.availableChoices) };
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
  ): Promise<"end_turn" | "cancelled"> {
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
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("sendUserTurn failed", { sessionId, error: msg });
      // The turn never started, so there is no turn to report a stop reason
      // for. Rejecting `session/prompt` is the honest answer.
      throw RequestError.internalError({ sessionId }, `could not start turn: ${msg}`);
    }

    const dedup = new StreamingDedup();
    const outputs = new ToolOutputAccumulator();
    const idleTimeoutMs = resolveTurnIdleTimeoutMs();
    const watchdog = new IdleWatchdog(idleTimeoutMs);
    this.#activity.set(sessionId, () => watchdog.touch());
    const onUpdate: SendTurnOptions["onSessionUpdate"] = (update) => {
      watchdog.touch();
      options.onSessionUpdate(update);
    };
    logger.info("Turn started", { sessionId, turnId: turn.turnId, idleTimeoutMs });

    try {
      // Start streaming first so that turn/started and early deltas are not missed,
      // but don't let a stuck stream block the response — completion is the source of truth.
      const streaming = this.#streamViaTurn(turn, onUpdate, dedup, outputs, abort.signal);
      // Inactivity watchdog: if turn.completed never settles (raced iterators, lost
      // routing, dead host) AND nothing is arriving, don't hang the ACP response forever.
      const outcome = await Promise.race([
        this.#waitForCompleted(turn.completed, abort.signal),
        watchdog.expired,
      ]).finally(() => watchdog.dispose());

      // Now that the terminal is known, give streaming a short drain window then abort.
      // Abortable iteration above ensures `abort` actually breaks a stuck `next()`.
      abort.abort();
      await Promise.race([
        streaming,
        new Promise<void>((r) => setTimeout(r, 500)),
      ]).catch(() => {});

      logger.info("Turn outcome", { sessionId, outcomeKind: (outcome as { kind?: string })?.kind });

      const outcomeKind = (outcome as { kind?: string })?.kind;
      if (outcomeKind === "cancelled" || outcomeKind === "unqueued") return "cancelled";
      // SS2.13.3b: the host died and no terminal is coming. Not a stop reason —
      // the turn's fate is genuinely unknown, which is an error, not an ending.
      if (outcomeKind === "terminalUnknown") {
        throw RequestError.internalError(
          { sessionId, turnId: turn.turnId },
          "muse host died; turn terminal unknown",
        );
      }
      if (outcomeKind === "completed") {
        const terminal = (outcome as { params?: { terminal?: string } })?.params?.terminal;
        if (terminal === "cancelled") return "cancelled";
        if (terminal === "failed") {
          const error = (outcome as { params?: { error?: { message?: string } } })?.params?.error;
          throw RequestError.internalError(
            { sessionId, turnId: turn.turnId },
            `turn failed: ${error?.message ?? "no reason given"}`,
          );
        }
        return "end_turn";
      }
      // Aborted with an outcome that names no terminal: the cancel is the fact.
      if (abort.signal.aborted) return "cancelled";
      return "end_turn";
    } catch (e) {
      if (e instanceof IdleTimeout) {
        logger.error("Turn went idle", { sessionId, turnId: turn.turnId, idleTimeoutMs });
        // Tell muse to drop it too, or the host keeps working a turn the client
        // has already been told about, and the next prompt on this session
        // queues behind a turn nobody will finish.
        await this.cancelTurn(sessionId).catch(() => {});
        throw RequestError.internalError(
          { sessionId, turnId: turn.turnId },
          `turn produced no output for ${idleTimeoutMs / 1000}s and was cancelled (MUSE_TURN_IDLE_TIMEOUT_MS)`,
        );
      }
      if (abort.signal.aborted) return "cancelled";
      if (e instanceof RequestError) throw e;
      logger.error("Turn streaming error", { sessionId, error: String(e) });
      throw RequestError.internalError({ sessionId }, `turn failed: ${String(e)}`);
    } finally {
      watchdog.dispose();
      this.#activity.delete(sessionId);
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
    this.#activity.clear();
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
    outputs: ToolOutputAccumulator,
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
            if (typeof d.delta !== "string" || !d.itemId) continue;
            if ((d.field ?? "text") === "text") dedup.recordDelta(d.itemId, d.delta);
            for (const u of deltaToSessionUpdates({ itemId: d.itemId, delta: d.delta, field: d.field }, outputs)) onUpdate(u);
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
