/**
 * ACP agent handlers, registered on the official SDK's agent app.
 *
 * The SDK owns the transport, the JSON-RPC framing and the schema validation;
 * this module owns only the translation between an ACP request and the MSP
 * manager. Every handler receives `{ params, client }`, where `client` is the
 * outbound half of the same connection — that is how a turn streams
 * `session/update` and asks `session/request_permission` while the
 * `session/prompt` request is still open.
 */

import { RequestError, methods } from "@agentclientprotocol/sdk";
import type { AgentApp, AgentContext } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { z } from "zod";
import { MODEL_CONFIG_ID } from "../msp/manager.js";
import type { MspManager } from "../msp/manager.js";
import { contentBlocksToInput } from "../bridge/contentMap.js";
import { logger } from "../util/logger.js";

/** ACP protocol version this adapter speaks. SDK 1.x carries the stable v1 wire schema. */
export const PROTOCOL_VERSION = 1;

const AGENT_INFO = {
  name: "muse-acp",
  title: "Muse ACP Adapter",
  version: "0.1.0",
} as const;

/**
 * A session id the adapter does not hold.
 *
 * -32002 is ACP's resource-not-found code, which is what the SDK's own
 * `RequestError.resourceNotFound` mints — so this stays the code the hand
 * rolled layer used, now sourced from the SDK rather than restated.
 */
function sessionNotFound(sessionId: string): RequestError {
  return RequestError.resourceNotFound(`session/${sessionId}`);
}

/**
 * ACP's UNSTABLE `session/set_model` (not in SDK 1.x's typed surface; the
 * wire shape is `{ sessionId, modelId }`). Some clients still send it ahead
 * of the stable `session/set_config_option`, so it is honoured as a second
 * spelling of the same gesture rather than answered `-32601`.
 */
const SET_MODEL_METHOD = "session/set_model";
const zSetModelParams = z.object({ sessionId: z.string(), modelId: z.string() });

/**
 * A client may name a model on `session/new` through `_meta.model` — Paseo
 * style `provider/model` profiles have nowhere else to put it — so it is
 * read when present and ignored when it is anything but a non-empty string.
 */
function requestedModel(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const model = (meta as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export function registerAgent(app: AgentApp, msp: MspManager): AgentApp {
  return app
    .onRequest(methods.agent.initialize, ({ params }) => {
      logger.info("ACP initialize", { clientInfo: params.clientInfo });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: AGENT_INFO,
      } satisfies schema.InitializeResponse;
    })

    .onRequest(methods.agent.authenticate, () => {
      // muse serve authenticates itself from ~/.config/muse/auth.json; the
      // adapter holds no credentials and advertises no auth methods, so there
      // is nothing for a client to authenticate against.
      return {};
    })

    .onRequest(methods.agent.session.new, async ({ params }) => {
      const record = await msp.createSession(params.cwd, requestedModel(params._meta));
      logger.info("Created session", { sessionId: record.sessionId, cwd: record.cwd, modelId: record.modelId });
      const configOptions = await msp.modelConfigOptions(record.sessionId);
      return {
        sessionId: record.sessionId,
        ...(configOptions ? { configOptions } : {}),
      } satisfies schema.NewSessionResponse;
    })

    .onRequest(methods.agent.session.load, async ({ params }) => {
      try {
        await msp.resumeSession(params.sessionId, params.cwd);
      } catch (e) {
        // A session muse cannot resume is not a session this adapter can load.
        // The hand-rolled layer silently created a NEW session here and handed
        // back its id under a `session/load` response, which no client reads —
        // so the caller kept the id it asked for and every later request on it
        // failed. Report it instead.
        logger.warn("Failed to resume session", { sessionId: params.sessionId, error: String(e) });
        throw sessionNotFound(params.sessionId);
      }
      const configOptions = await msp.modelConfigOptions(params.sessionId);
      return { ...(configOptions ? { configOptions } : {}) } satisfies schema.LoadSessionResponse;
    })

    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const { sessionId, configId } = params;
      if (!msp.hasSession(sessionId)) throw sessionNotFound(sessionId);
      if (configId !== MODEL_CONFIG_ID) {
        throw RequestError.invalidParams({ configId, reason: "unknown config option" });
      }
      if (typeof params.value !== "string" || !params.value) {
        throw RequestError.invalidParams({ configId, reason: "model value must be a catalog model id" });
      }
      await msp.setModel(sessionId, params.value);
      const configOptions = (await msp.modelConfigOptions(sessionId)) ?? [];
      return { configOptions } satisfies schema.SetSessionConfigOptionResponse;
    })

    .onRequest(SET_MODEL_METHOD, zSetModelParams, async ({ params }) => {
      if (!msp.hasSession(params.sessionId)) throw sessionNotFound(params.sessionId);
      await msp.setModel(params.sessionId, params.modelId);
      return {};
    })

    .onRequest(methods.agent.session.list, () => {
      return {
        sessions: msp.listSessions().map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
      } satisfies schema.ListSessionsResponse;
    })

    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const { sessionId } = params;
      if (!msp.hasSession(sessionId)) throw sessionNotFound(sessionId);

      const input = contentBlocksToInput(params.prompt);
      if (input.length === 0 || input.every((p) => !p.text.trim())) {
        logger.warn("Empty prompt received", { sessionId });
        return { stopReason: "refusal" } satisfies schema.PromptResponse;
      }

      logger.info("Prompt received", {
        sessionId,
        textPreview: input.map((p) => p.text.slice(0, 100)).join(" | ").slice(0, 200),
      });

      const stopReason = await msp.sendTurn(sessionId, input, {
        onSessionUpdate: (update) => {
          void sendUpdate(client, sessionId, update);
        },
        onRequestPermission: (toolCall, options) =>
          client.request(methods.client.session.requestPermission, { sessionId, toolCall, options }),
      });

      return { stopReason } satisfies schema.PromptResponse;
    })

    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      logger.info("Cancel requested", { sessionId: params.sessionId });
      await msp.cancelTurn(params.sessionId);
    });
}

/**
 * `session/update` is a notification, so nothing awaits it and a rejection has
 * nowhere to go. Swallowed rather than left to become an unhandled rejection
 * that would kill the adapter mid-turn — a dropped update costs the client one
 * frame of rendering; an unhandled rejection costs it the whole session.
 */
async function sendUpdate(
  client: AgentContext,
  sessionId: string,
  update: schema.SessionUpdate,
): Promise<void> {
  try {
    await client.notify(methods.client.session.update, { sessionId, update });
  } catch (e) {
    logger.warn("session/update failed", { sessionId, error: String(e) });
  }
}
