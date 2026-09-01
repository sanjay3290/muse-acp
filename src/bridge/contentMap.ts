/**
 * Content-block mapping between ACP and MSP.
 *
 * ACP ContentBlock[] (session/prompt)  →  MSP TurnStartParams.input
 * MSP Item (agentMessage/toolCall)     →  ACP SessionUpdate
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";

// MSP input shape (from @muse-code/msp TurnStartParams)
export interface MspInputBlock {
  type: "text";
  text: string;
}

/**
 * Convert ACP prompt content blocks to MSP input blocks.
 * - Text blocks are passed through.
 * - Image blocks are described as text (until MSP image support is confirmed).
 * - Resource blocks include URI + text if available.
 */
export function contentBlocksToInput(blocks: ContentBlock[]): MspInputBlock[] {
  const inputs: MspInputBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as unknown as Record<string, unknown>;
    switch (b.type) {
      case "text": {
        const text = (b as { text?: string }).text;
        if (typeof text === "string" && text.length > 0) {
          inputs.push({ type: "text", text });
        }
        break;
      }
      case "image": {
        const img = b as { data?: string; mimeType?: string };
        // MSP image support — fall back to text description
        inputs.push({
          type: "text",
          text: `[Image: ${img.mimeType ?? "unknown"} — ${img.data ? `${img.data.length} bytes base64` : "no data"}]`,
        });
        break;
      }
      case "resource": {
        const r = b as { resource?: { uri?: string; text?: string; blob?: string } };
        const uri = r.resource?.uri ?? "unknown";
        const text = r.resource?.text ?? r.resource?.blob ?? "";
        inputs.push({
          type: "text",
          text: text ? `Resource ${uri}:\n${text}` : `Resource: ${uri}`,
        });
        break;
      }
      case "resource_link": {
        const rl = b as { uri?: string };
        inputs.push({ type: "text", text: `Resource link: ${rl.uri ?? "unknown"}` });
        break;
      }
      case "audio": {
        inputs.push({ type: "text", text: "[Audio content — not yet supported]" });
        break;
      }
      default: {
        // Best-effort: stringify unknown blocks
        const text = (b as { text?: string }).text;
        if (typeof text === "string") inputs.push({ type: "text", text });
        else inputs.push({ type: "text", text: JSON.stringify(block).slice(0, 1000) });
      }
    }
  }
  // Fallback for completely unrecognized blocks (not for intentionally empty text)
  if (inputs.length === 0 && blocks.length > 0) {
    const hasOnlyEmptyText = blocks.every(
      (b) => (b as unknown as Record<string, unknown>).type === "text" && !((b as unknown as Record<string, unknown>).text as string),
    );
    if (!hasOnlyEmptyText) {
      inputs.push({ type: "text", text: JSON.stringify(blocks).slice(0, 2000) });
    }
  }
  return inputs;
}

/** Join MSP input blocks into a single display string (for logging). */
export function inputToDisplayText(inputs: MspInputBlock[]): string {
  return inputs.map((b) => b.text).join("\n");
}
