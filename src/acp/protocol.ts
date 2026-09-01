/**
 * ACP JSON-RPC stdio transport — NDJSON over stdin/stdout.
 *
 * Reads line-delimited JSON from stdin, dispatches to handler,
 * writes responses/notifications to stdout. Stderr is reserved
 * for logging.
 */

import { createInterface } from "node:readline";
import type { JsonRpcRequest, JsonRpcSuccess, JsonRpcError } from "./types.js";
import { logger } from "../util/logger.js";

export type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  id: number | string | undefined,
) => Promise<unknown>;

export interface ProtocolOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class AcpProtocol {
  #handler: RequestHandler;
  #output: NodeJS.WritableStream;
  #input: NodeJS.ReadableStream;
  #nextId = 1;
  #pendingRequests = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(handler: RequestHandler, options: ProtocolOptions = {}) {
    this.#handler = handler;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  /** Start reading and dispatching incoming messages. Resolves when stdin closes. */
  async listen(): Promise<void> {
    const rl = createInterface({ input: this.#input, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (e) {
        logger.warn("Failed to parse JSON-RPC line", { line: trimmed.slice(0, 200), error: String(e) });
        this.#sendError(null, -32700, "Parse error");
        continue;
      }
      this.#handleMessage(msg).catch((err) => {
        logger.error("Unhandled error in message handler", { error: String(err) });
      });
    }
  }

  async #handleMessage(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method as string | undefined;
    const id = msg.id as number | string | undefined;
    const params = msg.params as Record<string, unknown> | undefined;

    // Response to a client-initiated request (e.g. session/request_permission → client)
    if (method === undefined && id !== undefined) {
      const pending = this.#pendingRequests.get(id);
      if (pending) {
        this.#pendingRequests.delete(id);
        if (msg.error) {
          pending.reject(msg.error);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (method === undefined) return;

    // Notification (no id) or Request (has id)
    if (id === undefined) {
      // Notification — fire and forget
      try {
        await this.#handler(method, params, undefined);
      } catch (e) {
        logger.warn(`Notification handler error for ${method}`, { error: String(e) });
      }
    } else {
      // Request — must respond
      try {
        const result = await this.#handler(method, params, id);
        this.#sendResult(id, result);
      } catch (e: unknown) {
        const err = e as { code?: number; message?: string; data?: unknown };
        const code = typeof err.code === "number" ? err.code : -32603;
        const message = err.message ?? String(e);
        this.#sendError(id, code, message, err.data);
      }
    }
  }

  // ── Outgoing ────────────────────────────────────────────────────────────

  #sendResult(id: number | string, result: unknown): void {
    const msg: JsonRpcSuccess = { jsonrpc: "2.0", id, result: result ?? {} };
    this.#write(msg);
  }

  #sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const msg: JsonRpcError = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.#write(msg);
  }

  /** Send a JSON-RPC notification (no id). */
  notify(method: string, params?: Record<string, unknown>): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Send a JSON-RPC request to the client and await response. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      this.#write(msg);
      // Timeout after 5 minutes for permission requests
      const timer = setTimeout(() => {
        if (this.#pendingRequests.has(id)) {
          this.#pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 300_000);
      // Clear timer on settle — wrap resolve/reject
      const origResolve = resolve;
      const origReject = reject;
      this.#pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });
    });
  }

  #write(msg: unknown): void {
    const line = JSON.stringify(msg);
    this.#output.write(line + "\n");
    logger.debug("→ " + line.slice(0, 500));
  }
}
