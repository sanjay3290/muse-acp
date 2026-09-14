/**
 * Streaming bridge: MSP TurnHandle / Session fold → ACP session/update.
 *
 * Each MSP item kind maps to an ACP SessionUpdate variant.
 * The adapter owns the mapping and emits via onSessionUpdate callback.
 */

import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { logger } from "../util/logger.js";

/** MSP item kinds (from msp.d.ts ItemKind). */
export type MspItemKind =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "toolCall"
  | "userShell"
  | "subagent"
  | "workflow"
  | "compaction"
  | (string & {});

export interface MspItem {
  itemId: string;
  kind: MspItemKind;
  turnId: string;
  revision: number;
  status: string;
  text?: string;
  toolName?: string;
  // other fields pass through
  [k: string]: unknown;
}

/** Convert an MSP item delta or completed item to ACP session updates. */
export function itemToSessionUpdates(item: MspItem, delta?: string): SessionUpdate[] {
  const kind = item.kind;

  // Text delta streaming (item/delta with field=text)
  if (delta !== undefined) {
    if (kind === "agentMessage") {
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }];
    }
    if (kind === "reasoning") {
      return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } }];
    }
    if (kind === "userMessage") {
      return [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: delta } }];
    }
    // Tool call deltas — treat as tool_call_update streaming?
    if (kind === "toolCall") {
      // Emit as partial tool call content; ACP client may show as streaming
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: item.itemId,
          content: [{ type: "content", content: { type: "text", text: delta } }],
        },
      ];
    }
    // Fallback: treat as agent message
    return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }];
  }

  // Completed item — emit final chunks or tool calls
  if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") {
    if (kind === "toolCall") {
      const toolCallId = item.itemId;
      const toolName = (item.tool as string) ?? (item.toolName as string) ?? "tool";
      const status = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "pending";
      const acpKind = toolToAcpKind(toolName);
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolName,
          kind: acpKind,
          status,
          content: item.text
            ? [{ type: "content", content: { type: "text", text: item.text } }]
            : item.visibleOutput
              ? [{ type: "content", content: { type: "text", text: item.visibleOutput as string } }]
              : undefined,
        },
      ];
    }
    if (kind === "agentMessage" && item.text) {
      // Completed agent message — if we already streamed deltas, the final
      // completed event may duplicate. Caller deduplicates by tracking streamed text.
      // We emit nothing here if text was already streamed; but for non-streaming
      // (single-shot) items, emit the full text.
      // This function is called only when delta is undefined, so this is the completed path.
      // If text exists and wasn't streamed, emit it.
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } }];
    }
    if (kind === "reasoning" && item.text) {
      return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.text } }];
    }
  }

  // item/started — for tool calls, emit tool_call start
  if (item.status === "inProgress" && kind === "toolCall") {
    const toolCallId = item.itemId;
    const toolName = (item.tool as string) ?? (item.toolName as string) ?? "tool";
    return [
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolName,
        kind: toolToAcpKind(toolName),
        status: "in_progress",
        },
    ];
  }

  logger.debug("No ACP mapping for item", { kind, status: item.status });
  return [];
}

export function toolToAcpKind(toolName: string): ToolKind {
  const t = toolName.toLowerCase();
  if (t.includes("read") || t === "read_file" || t === "readfile") return "read";
  if (t.includes("write") || t.includes("edit") || t === "write_file" || t === "edit_file") return "edit";
  if (t === "bash" || t === "shell" || t.includes("exec") || t.includes("run") || t === "terminal") return "execute";
  if (t.includes("search") || t.includes("grep") || t.includes("find")) return "search";
  if (t.includes("fetch") || t.includes("web") || t === "web_fetch") return "fetch";
  if (t.includes("think") || t === "reasoning") return "think";
  return "other";
}

/** The `item/delta` params this adapter reads (msp.d.ts `ItemDeltaParams`). */
export interface MspDelta {
  itemId: string;
  delta: string;
  /** Dotted field path; absent means `"text"`. */
  field?: string;
}

/**
 * Accumulates streamed `toolCall.visibleOutput` per item.
 *
 * ACP `tool_call_update.content` REPLACES the tool call's content rather than
 * appending to it, so each output delta has to be re-sent as the whole text
 * so far, not as the new fragment alone.
 */
export class ToolOutputAccumulator {
  #byItem = new Map<string, string>();

  append(itemId: string, delta: string): string {
    const next = (this.#byItem.get(itemId) ?? "") + delta;
    this.#byItem.set(itemId, next);
    return next;
  }

  reset(): void {
    this.#byItem.clear();
  }
}

/**
 * Route one `item/delta` by its field path (tdd SS4.3.1).
 *
 * The MSP schema pins which item kinds stream which fields: `agentMessage`
 * streams `text`; `reasoning` streams `summary.<n>`; `toolCall` and
 * `userShell` stream `output`. Routing on the field is therefore exact
 * without knowing the item kind, which a delta does not carry. Before this,
 * every delta was forwarded as agent prose, so tool stdout and reasoning
 * summaries landed in the chat transcript as if the model had said them.
 */
export function deltaToSessionUpdates(delta: MspDelta, outputs: ToolOutputAccumulator): SessionUpdate[] {
  if (typeof delta.delta !== "string" || !delta.itemId) return [];
  const field = delta.field ?? "text";
  if (field === "text") {
    return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } }];
  }
  if (field === "summary" || field.startsWith("summary.")) {
    return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } }];
  }
  if (field === "output") {
    const soFar = outputs.append(delta.itemId, delta.delta);
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: delta.itemId,
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: soFar } }],
      },
    ];
  }
  logger.debug("Dropping delta on unmapped field", { field, itemId: delta.itemId });
  return [];
}

/** Simple dedup helper — tracks streamed text per turn to avoid double-emit. */
export class StreamingDedup {
  #streamedByItem = new Map<string, string>();

  /** Record that delta was streamed for item. */
  recordDelta(itemId: string, delta: string): void {
    const prev = this.#streamedByItem.get(itemId) ?? "";
    this.#streamedByItem.set(itemId, prev + delta);
  }

  /** Check if completed item's text was already fully streamed. */
  wasFullyStreamed(item: MspItem): boolean {
    if (!item.text) return true;
    const streamed = this.#streamedByItem.get(item.itemId) ?? "";
    return streamed === item.text;
  }

  reset(): void {
    this.#streamedByItem.clear();
  }
}
