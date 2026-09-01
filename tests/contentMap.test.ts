import { describe, it, expect } from "vitest";
import { contentBlocksToInput } from "../src/bridge/contentMap.js";

describe("contentBlocksToInput", () => {
  it("converts text blocks", () => {
    const input = contentBlocksToInput([{ type: "text", text: "hello world" }]);
    expect(input).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("converts multiple text blocks", () => {
    const input = contentBlocksToInput([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(input).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("handles image blocks as text description", () => {
    const input = contentBlocksToInput([
      { type: "image", data: "abc123", mimeType: "image/png" } as never,
    ]);
    expect(input[0].text).toContain("Image");
    expect(input[0].text).toContain("image/png");
  });

  it("handles resource blocks", () => {
    const input = contentBlocksToInput([
      { type: "resource", resource: { uri: "file:///tmp/test.txt", text: "file content" } } as never,
    ]);
    expect(input[0].text).toContain("file:///tmp/test.txt");
    expect(input[0].text).toContain("file content");
  });

  it("handles resource_link blocks", () => {
    const input = contentBlocksToInput([
      { type: "resource_link", uri: "https://example.com" } as never,
    ]);
    expect(input[0].text).toContain("https://example.com");
  });

  it("handles empty array", () => {
    expect(contentBlocksToInput([])).toEqual([]);
  });

  it("skips empty text blocks", () => {
    const input = contentBlocksToInput([{ type: "text", text: "" }]);
    expect(input).toEqual([]);
  });

  it("handles audio blocks", () => {
    const input = contentBlocksToInput([{ type: "audio", data: "abc", mimeType: "audio/mp3" } as never]);
    expect(input[0].text).toContain("Audio");
  });
});
