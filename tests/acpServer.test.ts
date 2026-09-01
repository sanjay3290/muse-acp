import { describe, it, expect, vi } from "vitest";
import { AcpServer } from "../src/acp/server.js";

function createMockMsp() {
  return {
    createSession: vi.fn(async (cwd: string) => ({
      sessionId: "test-session-1",
      cwd,
      mspSession: {},
    })),
    resumeSession: vi.fn(async (sessionId: string, cwd?: string) => ({
      sessionId,
      cwd: cwd ?? "/tmp",
      mspSession: {},
    })),
    hasSession: vi.fn(() => true),
    listSessions: vi.fn(() => [{ sessionId: "s1", cwd: "/tmp" }]),
    sendTurn: vi.fn(async () => "end_turn"),
    cancelTurn: vi.fn(async () => {}),
    ensureClient: vi.fn(async () => ({})),
    getSession: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

describe("AcpServer", () => {
  it("handles initialize", async () => {
    const msp = createMockMsp();
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    const result = (await server.handleRequest("initialize", { protocolVersion: 1 } as never, 1)) as Record<string, unknown>;
    expect(result.protocolVersion).toBe(1);
    expect((result.agentInfo as Record<string, unknown>).name).toBe("muse-acp");
  });

  it("handles session/new", async () => {
    const msp = createMockMsp();
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    await server.handleRequest("initialize", { protocolVersion: 1 } as never, 1);
    const result = (await server.handleRequest("session/new", { cwd: "/tmp" } as never, 2)) as Record<string, unknown>;
    expect(result.sessionId).toBe("test-session-1");
    expect(msp.createSession).toHaveBeenCalledWith("/tmp");
  });

  it("handles session/prompt", async () => {
    const msp = createMockMsp();
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    await server.handleRequest("initialize", { protocolVersion: 1 } as never, 1);
    const result = (await server.handleRequest(
      "session/prompt",
      { sessionId: "test-session-1", prompt: [{ type: "text", text: "hello" }] } as never,
      3,
    )) as Record<string, unknown>;
    expect(result.stopReason).toBe("end_turn");
    expect(msp.sendTurn).toHaveBeenCalled();
  });

  it("rejects prompt for unknown session", async () => {
    const msp = createMockMsp();
    msp.hasSession.mockReturnValue(false);
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    await server.handleRequest("initialize", { protocolVersion: 1 } as never, 1);
    await expect(
      server.handleRequest("session/prompt", { sessionId: "bad-id", prompt: [{ type: "text", text: "hi" }] } as never, 2),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("handles session/cancel", async () => {
    const msp = createMockMsp();
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    const result = await server.handleRequest("session/cancel", { sessionId: "s1" } as never, 1);
    expect(msp.cancelTurn).toHaveBeenCalledWith("s1");
    expect(result).toEqual({});
  });

  it("returns error for unknown method", async () => {
    const msp = createMockMsp();
    const server = new AcpServer({ mspManager: msp as never, onSessionUpdate: () => {} });
    await expect(server.handleRequest("unknown/method", {}, 1)).rejects.toMatchObject({ code: -32601 });
  });
});
