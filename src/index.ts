/**
 * muse-acp — ACP adapter for Muse Code.
 *
 * Programmatic entry — re-exports for embedding.
 */

export { registerAgent, PROTOCOL_VERSION } from "./acp/agent.js";

export { MspManager } from "./msp/manager.js";
export type { SessionRecord, SendTurnOptions } from "./msp/manager.js";

export { contentBlocksToInput, inputToDisplayText } from "./bridge/contentMap.js";
export type { MspInputBlock } from "./bridge/contentMap.js";

export { itemToSessionUpdates, StreamingDedup, toolToAcpKind } from "./bridge/streaming.js";
export type { MspItem, MspItemKind } from "./bridge/streaming.js";

export { logger, setLogLevel } from "./util/logger.js";
export type { LogLevel } from "./util/logger.js";

export { resolveMuseBin, resolveWorkspaceRoot } from "./util/env.js";
