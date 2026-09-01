import { describe, it, expect } from "vitest";
import { itemToSessionUpdates, StreamingDedup } from "../src/bridge/streaming.js";

describe("itemToSessionUpdates", () => {
  it("maps agentMessage delta to agent_message_chunk", () => {
    const updates = itemToSessionUpdates(
      { itemId: "1", kind: "agentMessage", turnId: "t1", revision: 1, status: "inProgress" },
      "hello ",
    );
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
    ]);
  });

  it("maps reasoning delta to agent_thought_chunk", () => {
    const updates = itemToSessionUpdates(
      { itemId: "1", kind: "reasoning", turnId: "t1", revision: 1, status: "inProgress" },
      "thinking...",
    );
    expect(updates[0].sessionUpdate).toBe("agent_thought_chunk");
  });

  it("maps toolCall item to tool_call", () => {
    const updates = itemToSessionUpdates({
      itemId: "tool-1",
      kind: "toolCall",
      turnId: "t1",
      revision: 1,
      status: "completed",
      text: "tool output",
      toolName: "read_file",
      toolCallId: "call-1",
    });
    expect(updates[0].sessionUpdate).toBe("tool_call");
    expect((updates[0] as Record<string, unknown>).toolCallId).toBe("call-1");
  });

  it("maps toolCall inProgress to tool_call", () => {
    const updates = itemToSessionUpdates({
      itemId: "tool-2",
      kind: "toolCall",
      turnId: "t1",
      revision: 1,
      status: "inProgress",
      toolName: "bash",
    });
    expect(updates[0].sessionUpdate).toBe("tool_call");
  });

  it("returns empty for unknown kind without delta", () => {
    const updates = itemToSessionUpdates({
      itemId: "1",
      kind: "unknownKind",
      turnId: "t1",
      revision: 1,
      status: "completed",
    });
    expect(updates).toEqual([]);
  });
});

describe("StreamingDedup", () => {
  it("tracks deltas and detects fully streamed", () => {
    const dedup = new StreamingDedup();
    dedup.recordDelta("item-1", "hello ");
    dedup.recordDelta("item-1", "world");
    expect(dedup.wasFullyStreamed({ itemId: "item-1", text: "hello world" } as never)).toBe(true);
    expect(dedup.wasFullyStreamed({ itemId: "item-1", text: "hello world!" } as never)).toBe(false);
  });

  it("returns true for item without text", () => {
    const dedup = new StreamingDedup();
    expect(dedup.wasFullyStreamed({ itemId: "x" } as never)).toBe(true);
  });

  it("resets correctly", () => {
    const dedup = new StreamingDedup();
    dedup.recordDelta("item-1", "hello");
    dedup.reset();
    expect(dedup.wasFullyStreamed({ itemId: "item-1", text: "hello" } as never)).toBe(false);
  });
});
