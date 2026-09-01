# ACP Registry entry

Submission draft for the [ACP Registry](https://github.com/agentclientprotocol/registry),
which is how Zed and JetBrains users discover ACP agents.

## Submitting

The npm package must be published **first** — the registry build validates that
the `distribution.npx` package resolves.

1. `npm publish --access public` from the repo root
2. Fork https://github.com/agentclientprotocol/registry
3. Copy `muse-acp/` from this directory to the fork root
4. Open a PR

Keep `version` in `agent.json` in lockstep with `package.json`; the registry
pins an exact version.

Validated locally against `agent.schema.json` and the registry's own
`build_registry.py --dry-run`.
