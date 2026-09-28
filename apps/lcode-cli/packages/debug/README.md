# debug

Development-only trace and context viewer for LCode.

Run from the repository root:

```sh
pnpm --filter debug dev
```

The Hono API reads existing local diagnostics only:

- `~/.lcode/cli/log/*.jsonl`
- `~/.lcode/cli/db/db.sqlite`
- an optional session event JSONL file or directory selected in the UI

It does not modify agent runtime behavior or write back to the agent database.

The debug server also starts a local network capture proxy by default:

- API/UI: `http://127.0.0.1:4174`
- Proxy: `http://127.0.0.1:4184`
- Local CA: `packages/debug/certs/network-ca/certs/ca.pem`

Run the CLI you want to inspect with the environment values shown in the Network panel, usually `LCODE_HTTP_PROXY` and `LCODE_AGENT_CA_CERT`. The agent derives standard proxy and CA variables only inside controlled subprocess boundaries. Disable the proxy with `LCODE_DEBUG_NETWORK_CAPTURE=0` when you only want log/DB inspection.
