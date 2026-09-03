/**
 * Agent handlers, driven end to end through the official SDK.
 *
 * `client().connectWith(agentApp, ...)` wires both sides in-process over the
 * real ACP layer, so every request and response here is schema-validated the
 * same way it is on a stdio connection. That is the point: the hand-rolled
 * layer these tests replace could not catch a shape the schema rejects.
 */

import { describe, it, expect, vi } from "vitest";
import { agent, client, methods, RequestError } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { registerAgent } from "../src/acp/agent.js";
import type { MspManager, SendTurnOptions } from "../src/msp/manager.js";

type Turn = (
  sessionId: string,
  input: { type: "text"; text: string }[],
  options: SendTurnOptions,
) => Promise<"end_turn" | "cancelled">;

const CATALOG = [
  { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", description: null, isDefault: false },
  { modelId: "muse-spark-1.3-contributor", displayLabel: "muse-spark-1.3-contributor", description: "Your content may be used.", isDefault: true },
];

function fakeMsp(overrides: { sendTurn?: Turn; models?: typeof CATALOG | "unavailable" } = {}) {
  const sessions = new Map<string, { sessionId: string; cwd: string; modelId?: string }>();
  const models = overrides.models ?? CATALOG;
  let n = 0;
  const msp = {
    createSession: vi.fn(async (cwd: string, modelId?: string) => {
      const rec = { sessionId: `sess-${++n}`, cwd, modelId };
      sessions.set(rec.sessionId, rec);
      return rec;
    }),
    setModel: vi.fn(async (sessionId: string, modelId: string) => {
      const rec = sessions.get(sessionId);
      if (!rec) throw new Error("no such session");
      rec.modelId = modelId;
    }),
    modelConfigOptions: vi.fn(async (sessionId: string) => {
      const rec = sessions.get(sessionId);
      if (!rec || models === "unavailable") return undefined;
      const current = rec.modelId ?? models.find((m) => m.isDefault)!.modelId;
      return [
        {
          id: "model",
          name: "Model",
          category: "model" as const,
          type: "select" as const,
          currentValue: current,
          options: models.map((m) => ({ value: m.modelId, name: m.displayLabel })),
        },
      ];
    }),
    resumeSession: vi.fn(async (sessionId: string) => {
      const rec = sessions.get(sessionId);
      if (!rec) throw new Error("no such session");
      return rec;
    }),
    hasSession: (id: string) => sessions.has(id),
    listSessions: () => [...sessions.values()],
    getSession: (id: string) => sessions.get(id),
    cancelTurn: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendTurn: vi.fn(overrides.sendTurn ?? (async () => "end_turn" as const)),
  };
  return msp as unknown as MspManager & typeof msp;
}

function connect(msp: MspManager, clientApp = client({ name: "test" })) {
  const app = registerAgent(agent({ name: "muse-acp" }), msp);
  return <T>(op: (cx: schema.ClientContext) => Promise<T>) => clientApp.connectWith(app, op);
}

const INIT = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "t", version: "1" } };
const prompt = (sessionId: string, text = "hi") => ({
  sessionId,
  prompt: [{ type: "text" as const, text }],
});

describe("initialize", () => {
  it("advertises v1 and the capabilities the adapter actually implements", async () => {
    const res = await connect(fakeMsp())((cx) => cx.request(methods.agent.initialize, INIT));
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities?.loadSession).toBe(true);
    expect(res.agentCapabilities?.promptCapabilities).toMatchObject({ image: true, audio: false });
    expect(res.agentInfo?.name).toBe("muse-acp");
  });
});

describe("model selection", () => {
  it("publishes the catalog as a `model` config option on session/new", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const res = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      const opt = res.configOptions?.find((o) => o.id === "model");
      expect(opt).toBeDefined();
      expect(opt?.category).toBe("model");
      expect(opt).toMatchObject({ type: "select", currentValue: "muse-spark-1.3-contributor" });
      expect((opt as { options: { value: string }[] }).options.map((o) => o.value)).toEqual([
        "muse-spark-1.3",
        "muse-spark-1.3-contributor",
      ]);
      expect(msp.createSession).toHaveBeenCalledWith("/tmp/a", undefined);
    });
  });

  it("omits configOptions when the catalog is unavailable", async () => {
    const msp = fakeMsp({ models: "unavailable" });
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const res = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      expect(res.configOptions).toBeUndefined();
    });
  });

  it("honours `_meta.model` on session/new", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const res = await cx.request(methods.agent.session.new, {
        cwd: "/tmp/a",
        mcpServers: [],
        _meta: { model: "muse-spark-1.3" },
      });
      expect(msp.createSession).toHaveBeenCalledWith("/tmp/a", "muse-spark-1.3");
      expect(res.configOptions?.[0]).toMatchObject({ currentValue: "muse-spark-1.3" });
    });
  });

  it("session/set_config_option switches the model and echoes the new state", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const { sessionId } = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      const res = await cx.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        value: "muse-spark-1.3",
      });
      expect(msp.setModel).toHaveBeenCalledWith(sessionId, "muse-spark-1.3");
      expect(res.configOptions[0]).toMatchObject({ id: "model", currentValue: "muse-spark-1.3" });
    });
  });

  it("rejects an unknown config option and an unknown session", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const { sessionId } = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      await expect(
        cx.request(methods.agent.session.setConfigOption, { sessionId, configId: "nope", value: "x" }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        cx.request(methods.agent.session.setConfigOption, { sessionId: "ghost", configId: "model", value: "x" }),
      ).rejects.toMatchObject({ code: -32002 });
      expect(msp.setModel).not.toHaveBeenCalled();
    });
  });

  it("unstable session/set_model is a second spelling of the same gesture", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const { sessionId } = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      await cx.request("session/set_model" as never, { sessionId, modelId: "muse-spark-1.3" } as never);
      expect(msp.setModel).toHaveBeenCalledWith(sessionId, "muse-spark-1.3");
    });
  });
});

describe("sessions", () => {
  it("creates, lists and loads", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const a = await cx.request(methods.agent.session.new, { cwd: "/tmp/a", mcpServers: [] });
      const b = await cx.request(methods.agent.session.new, { cwd: "/tmp/b", mcpServers: [] });
      const list = await cx.request(methods.agent.session.list, {});
      expect(list.sessions.map((s) => s.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
      expect(list.sessions.find((s) => s.sessionId === a.sessionId)?.cwd).toBe("/tmp/a");
      await expect(cx.request(methods.agent.session.load, { sessionId: a.sessionId, cwd: "/tmp/a", mcpServers: [] })).resolves.toBeDefined();
    });
  });

  it("reports a session it cannot load rather than silently creating a new one", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      await expect(
        cx.request(methods.agent.session.load, { sessionId: "ghost", cwd: "/tmp", mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32002 });
      expect(msp.createSession).not.toHaveBeenCalled();
    });
  });

  it("rejects a prompt for an unknown session with -32002", async () => {
    await connect(fakeMsp())(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      await expect(cx.request(methods.agent.session.prompt, prompt("ghost"))).rejects.toMatchObject({
        code: -32002,
      });
    });
  });
});

describe("prompt", () => {
  it("returns the turn's stop reason", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      const res = await cx.request(methods.agent.session.prompt, prompt(s.sessionId));
      expect(res.stopReason).toBe("end_turn");
    });
  });

  it("refuses an empty prompt without starting a turn", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      const res = await cx.request(methods.agent.session.prompt, prompt(s.sessionId, "   "));
      expect(res.stopReason).toBe("refusal");
      expect(msp.sendTurn).not.toHaveBeenCalled();
    });
  });

  it("streams session/update notifications to the client", async () => {
    const seen: schema.SessionUpdate[] = [];
    const msp = fakeMsp({
      sendTurn: async (_id, _input, options) => {
        options.onSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
        options.onSessionUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "bash",
          kind: "execute",
          status: "completed",
        });
        return "end_turn";
      },
    });
    const clientApp = client({ name: "test" }).onNotification(
      methods.client.session.update,
      ({ params }) => { seen.push(params.update); },
    );
    await connect(msp, clientApp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, prompt(s.sessionId));
    });
    // The notifications are in flight when prompt resolves; let them land.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((u) => u.sessionUpdate)).toEqual(["agent_message_chunk", "tool_call"]);
  });

  it("round-trips session/request_permission and hands the outcome back", async () => {
    let outcome: schema.RequestPermissionResponse | undefined;
    const msp = fakeMsp({
      sendTurn: async (_id, _input, options) => {
        outcome = await options.onRequestPermission!(
          { toolCallId: "c1", title: "bash", kind: "execute", status: "pending" },
          [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "abort", name: "Reject", kind: "reject_once" },
          ],
        );
        return "end_turn";
      },
    });
    const clientApp = client({ name: "test" }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) => ({ outcome: { outcome: "selected", optionId: params.options[0].optionId } }) as const,
    );
    await connect(msp, clientApp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, prompt(s.sessionId));
    });
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("surfaces a turn failure as a JSON-RPC error, not a stop reason", async () => {
    const msp = fakeMsp({
      sendTurn: async () => {
        throw RequestError.internalError({}, "turn exceeded 120s and was cancelled");
      },
    });
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      await expect(cx.request(methods.agent.session.prompt, prompt(s.sessionId))).rejects.toMatchObject({
        code: -32603,
      });
    });
  });
});

describe("cancel", () => {
  it("forwards session/cancel to the manager", async () => {
    const msp = fakeMsp();
    await connect(msp)(async (cx) => {
      await cx.request(methods.agent.initialize, INIT);
      const s = await cx.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] });
      await cx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
      await new Promise((r) => setTimeout(r, 20));
      expect(msp.cancelTurn).toHaveBeenCalledWith(s.sessionId);
    });
  });
});
