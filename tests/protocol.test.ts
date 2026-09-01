import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { AcpProtocol } from "../src/acp/protocol.js";

function createProtocol(handler: (method: string, params: unknown, id: unknown) => Promise<unknown>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
  });
  const protocol = new AcpProtocol(handler as never, { input, output });
  return {
    protocol,
    input,
    output,
    getOutput: () => buf,
    getMessages: () => buf.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

describe("AcpProtocol", () => {
  it("handles initialize request", async () => {
    const { protocol, input, getMessages } = createProtocol(async (method) => {
      if (method === "initialize") return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "test", version: "0.1.0" } };
      throw Object.assign(new Error("not found"), { code: -32601 });
    });

    const listenPromise = protocol.listen();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    input.end();

    await listenPromise;
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(1);
    expect(msgs[0].result.protocolVersion).toBe(1);
  });

  it("handles unknown method with error", async () => {
    const { protocol, input, getMessages } = createProtocol(async () => {
      throw Object.assign(new Error("Method not found: foo/bar"), { code: -32601 });
    });

    const listenPromise = protocol.listen();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "foo/bar", params: {} }) + "\n");
    input.end();

    await listenPromise;
    const msgs = getMessages();
    expect(msgs[0].error.code).toBe(-32601);
  });

  it("handles notifications without response", async () => {
    let called = false;
    const { protocol, input, getMessages } = createProtocol(async (method, _params, id) => {
      if (id === undefined) called = true;
      return {};
    });

    const listenPromise = protocol.listen();
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    input.end();

    await listenPromise;
    expect(called).toBe(true);
    const msgs = getMessages();
    // Only the request gets a response, notification does not
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(1);
  });

  it("sends notifications via notify()", async () => {
    const { protocol, getMessages } = createProtocol(async () => ({}));
    protocol.notify("session/update", { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
    // Give it a tick to write
    await new Promise((r) => setTimeout(r, 10));
    const msgs = getMessages();
    expect(msgs[0].method).toBe("session/update");
    expect(msgs[0].params.sessionId).toBe("test");
  });
});
