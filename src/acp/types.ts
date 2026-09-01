/**
 * ACP (Agent Client Protocol) types — JSON-RPC 2.0 over stdio.
 *
 * Mirrors the Python `agent-client-protocol` (acp) schema v1.
 * We implement the wire surface directly so the adapter has no
 * Python dependency and works as a standalone Node binary.
 */

// ── JSON-RPC ────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

// ── ACP Content Blocks (prompt input) ────────────────────────────────────

export interface TextContentBlock {
  type: "text";
  text: string;
  annotations?: unknown;
}

export interface ImageContentBlock {
  type: "image";
  data: string; // base64
  mimeType: string;
  annotations?: unknown;
}

export interface AudioContentBlock {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: unknown;
}

export interface ResourceContentBlock {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
  annotations?: unknown;
}

export interface EmbeddedResourceContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  mimeType?: string;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | ResourceContentBlock
  | EmbeddedResourceContentBlock;

// ── ACP Requests ──────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
    [k: string]: unknown;
  };
  clientInfo?: { name: string; version: string; title?: string };
  _meta?: Record<string, unknown>;
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
  _meta?: Record<string, unknown>;
}

export interface LoadSessionParams {
  cwd: string;
  sessionId: string;
  mcpServers?: unknown[];
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

export interface CancelParams {
  sessionId: string;
}

export interface SetSessionModeParams {
  sessionId: string;
  modeId: string;
}

export interface SetSessionModelParams {
  sessionId: string;
  modelId: string;
}

// ── ACP Responses ─────────────────────────────────────────────────────────

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    loadSession?: boolean;
    sessionCapabilities?: { fork?: unknown; list?: unknown; resume?: unknown };
  };
  agentInfo: { name: string; version: string; title?: string };
  authMethods?: unknown[];
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | (string & {});
}

// ── ACP Notifications (agent → client) ────────────────────────────────────

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; kind: string; status: string; content?: unknown[]; locations?: unknown[]; rawInput?: unknown }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status?: string; title?: string; content?: unknown[]; locations?: unknown[]; rawInput?: unknown }
  | { sessionUpdate: "plan"; entries: Array<{ content: string; priority: string; status: string }> }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown };

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

// ── Client → Agent requestPermission ─────────────────────────────────────

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind: string; status: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

// ── Error codes ───────────────────────────────────────────────────────────

export const ACP_ERROR_SESSION_NOT_FOUND = -32002;
export const ACP_ERROR_INVALID_PARAMS = -32602;
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
