import { describe, it, expect } from "vitest";
import { deltaToSessionUpdates, itemToSessionUpdates, StreamingDedup, ToolOutputAccumulator } from "../src/bridge/streaming.js";

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
      callId: "call-1",
    });
    expect(updates[0].sessionUpdate).toBe("tool_call");
    // Identity is the MSP item id (the task id), never the provider call id:
    // deltas and approvals carry only the item id.
    expect((updates[0] as Record<string, unknown>).toolCallId).toBe("tool-1");
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

describe("deltaToSessionUpdates", () => {
  it("routes text deltas (explicit or default field) to agent_message_chunk", () => {
    const acc = new ToolOutputAccumulator();
    expect(deltaToSessionUpdates({ itemId: "m1", delta: "hi", field: "text" }, acc)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(deltaToSessionUpdates({ itemId: "m1", delta: "hi" }, acc)[0].sessionUpdate).toBe("agent_message_chunk");
  });

  it("routes reasoning summary parts to agent_thought_chunk", () => {
    const acc = new ToolOutputAccumulator();
    const [u] = deltaToSessionUpdates({ itemId: "r1", delta: "plan", field: "summary.0" }, acc);
    expect(u.sessionUpdate).toBe("agent_thought_chunk");
  });

  it("routes tool output to tool_call_update keyed on the item id, re-sending the whole text", () => {
    const acc = new ToolOutputAccumulator();
    const first = deltaToSessionUpdates({ itemId: "t1", delta: "acp\n", field: "output" }, acc);
    const second = deltaToSessionUpdates({ itemId: "t1", delta: "bridge\n", field: "output" }, acc);
    expect(first).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "acp\n" } }],
      },
    ]);
    expect((second[0] as { content: { content: { text: string } }[] }).content[0].content.text).toBe("acp\nbridge\n");
  });

  it("drops deltas on fields it does not map instead of leaking them as prose", () => {
    const acc = new ToolOutputAccumulator();
    expect(deltaToSessionUpdates({ itemId: "x", delta: "??", field: "children.0" }, acc)).toEqual([]);
    expect(deltaToSessionUpdates({ itemId: "", delta: "??" }, acc)).toEqual([]);
  });
});
