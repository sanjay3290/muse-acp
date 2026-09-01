# muse-acp — ACP Adapter for Muse Code

Bridges [Agent Client Protocol (ACP)](https://agentclientprotocol.com) to [Muse Code](https://github.com/meta-models/muse-code-sdk) via its [Muse Session Protocol (MSP)](https://meta-models.github.io/muse-code-sdk).

Use Muse from any ACP-compatible client (e.g. Zed) without leaving your editor.

```
ACP client (Zed)  ──stdio JSON-RPC──▶  muse-acp  ──MSP / muse serve──▶  Muse engine
```

## How it works

| ACP (client ↔ adapter) | MSP (adapter ↔ muse) | Owner |
|---|---|---|
| `initialize` | `initialize` handshake + `muse serve` spawn | `msp/manager.ts` |
| `session/new {cwd}` | `session/start {workspaceRoot}` | `msp/manager.ts` |
| `session/prompt {prompt: ContentBlock[]}` | `turn/start {input: [{type:"text"}]}` → `TurnHandle` iterators | `bridge/contentMap.ts` + `msp/manager.ts` |
| `session/update` notifications | `item/delta`, `item/completed`, `turn/completed` | `bridge/streaming.ts` |
| `session/request_permission` | `ApprovalRouter` (`approval/requested` → `approval/decide`) | `msp/manager.ts` |
| `session/cancel` | `TurnHandle` abort | `msp/manager.ts` |

Content blocks (`text`, `image`, `resource`, `resource_link`, `audio`) are mapped in `src/bridge/contentMap.ts`. Streaming deltas and tool calls are fanned out to ACP `session/update` via `src/bridge/streaming.ts`.

## Install

```sh
git clone https://github.com/<owner>/muse-acp
cd muse-acp
npm install
npm run build
```

Requires Node 20+ and a `muse` binary on `PATH` (or set `MUSE_BIN`).

```sh
# check
muse serve --help
which muse   # e.g. ~/.local/bin/muse
```

## Usage

### As ACP agent (stdio)

Add to your ACP client's agent config (Zed example):

```json
{
  "agents": {
    "muse": {
      "command": "node",
      "args": ["/path/to/muse-acp/dist/src/cli.js"],
      "env": { "MUSE_BIN": "/path/to/muse" }
    }
  }
}
```

Or with the installed binary:

```json
{
  "agents": {
    "muse": {
      "command": "muse-acp"
    }
  }
}
```

CLI options:

```sh
muse-acp --help
muse-acp --muse-bin /custom/path/muse --log-level debug
MUSE_BIN=/custom/muse muse-acp
MUSE_ACP_LOG_LEVEL=debug muse-acp
```

Logs go to **stderr only** — stdout is reserved for ACP JSON-RPC.

### Direct test (no editor)

```sh
# ACP initialize
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  | node dist/src/cli.js

# Full flow: initialize → session/new → prompt (needs muse binary)
# Use any ACP client that speaks session/new + session/prompt
```

### Programmatic

```ts
import { MspManager } from "muse-acp";
import { contentBlocksToInput } from "muse-acp/dist/src/bridge/contentMap.js";

const mgr = new MspManager();
const session = await mgr.createSession("/path/to/workspace");
const stopReason = await mgr.sendTurn(session.sessionId,
  contentBlocksToInput([{ type: "text", text: "fix the failing tests" }]),
  { onSessionUpdate: (u) => console.log(u) },
);
```

## Project layout

```
src/
  cli.ts              # shebang entry, arg parsing, ACP stdio loop
  acp/
    protocol.ts       # ACP JSON-RPC ndjson transport (stdin/stdout)
    server.ts         # ACP Agent side (initialize, session/new, prompt, cancel)
    types.ts          # ACP wire types
  msp/
    manager.ts        # MuseClient lifecycle (spawn, handshake, session store)
  bridge/
    contentMap.ts     # ACP ContentBlock[] ↔ MSP input
    streaming.ts      # MSP TurnHandle → ACP session/update
  util/
    logger.ts         # stderr-only logger
    env.ts            # muse binary resolution

vendor/
  muse-sdk/src/       # vendored @muse-code/sdk (tdd SS7.1 facade)
  msp-ts/             # vendored @muse-code/msp wire types (msp.d.ts)

tests/
  contentMap.test.ts
  streaming.test.ts
  protocol.test.ts
  acpServer.test.ts
```

`vendor/` is a build-time copy of `muse-code-sdk` (`clients/sdk-ts/src` + `clients/msp-ts` + `schema/msp/msp.d.ts`). It is not a fork — edits belong upstream in `meta-models/muse-code-sdk`.

Two local patches are applied on top of the vendor tree and will be lost on re-vendor. Re-apply each with `patch -p1 < patches/<name>.patch` after copying a new vendor tree:

- `patches/muse-sdk-multistage-approval.patch` — drives the approval handler from `approval/updated`, not `approval/requested` alone (`facade/approval.ts`, `facade/session.ts`). A compound shell command (`wc a.txt; echo x`) is one approval with N stages; muse asks once and then advances every later stage with `approval/updated` only. Without the patch the SDK decides stage 1 and the approval — and the turn — pends forever. Upstream fix belongs in `ApprovalRouter`. Covered by `tests/approvalStages.test.ts`.
- `patches/muse-sdk-connection-getter.patch` — exposes `MuseClient.connection` (getter for `turn/cancel` in `msp/manager.ts`). Upstream fix would be to expose a `turnCancel`/`turnInterrupt` method on the facade or to make `MuseClient`'s connection accessible.

## Protocol notes

- **ACP version**: 1. `agentCapabilities` advertises `image`, `embeddedContext`, `loadSession`.
- **MSP fingerprint**: pinned from `muse-code-sdk` schema manifest (`sha256:…`). Verified on `initialize` handshake (advisory, via `fingerprint.ts`).
- **One `muse serve` per adapter**: `MuseClient` multiplexes many ACP sessions over one `muse serve` child (one `Connection`). Each `session/new` maps to one MSP `session/start`.
- **Approvals**: `Session.onApproval` → ACP `session/request_permission` → `approval/decide`. Default-deny if no handler.
- **Multi-stage approvals**: a compound shell command (`wc -c f.txt; cat f.txt`) is ONE muse approval with one stage per command. Muse asks for each stage in turn, so the ACP client sees **N separate `session/request_permission` calls for one tool call**. Expected, not a bug — in Zed that is several prompts for one command. Stage 1 arrives as `approval/requested`; stages 2..N arrive as `approval/updated` (see the vendor patch above).
- **Streaming**: `TurnHandle.deltas()` + `TurnHandle.items()` are consumed concurrently; `TurnHandle.completed` (`Promise<TurnOutcome>`) drives `stopReason`.

## Limitations

When `muse-acp` is spawned **inside** Muse Code's own sandbox (e.g. as a
`muse.bash` tool), `muse serve` cannot read `~/.config/muse/auth.json`
(`Operation not permitted`). The adapter will return `connection reached EOF`
for `session/new`. This is expected — run `muse-acp` from your ACP client
(Zed, etc.) outside the Muse sandbox, or launch Muse with sandbox disabled.

## Development

```sh
npm run build        # tsc
npm run dev          # tsx src/cli.ts (no build)
npm test             # vitest (26 tests, no muse binary needed)
npm run lint         # tsc --noEmit
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).

This repository vendors third-party code that is **not** Apache-2.0:
`vendor/muse-sdk/` and `vendor/msp-ts/` are from
[`meta-models/muse-code-sdk`](https://github.com/meta-models/muse-code-sdk),
Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the MIT
License. The full MIT text is preserved alongside each. Local modifications to
the vendored SDK are kept as patches in `patches/` and documented above. See
[NOTICE](NOTICE) for the full third-party attribution.
