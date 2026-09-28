# LCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="LCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">Feishu community</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

LCode is an AI coding workspace with desktop, browser, and terminal interfaces. This repository contains the clients, backend services, shared UI, and Agent CLI and runtime source code.

| Interface                    | Purpose                                                                                   | Development command            |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Desktop                      | Electron desktop application                                                              | `pnpm dev:desktop`             |
| Web / LCode CLI distribution | Terminal and browser workspace; packages the TUI, Web client, backend, and Agent together | `pnpm dev:web`                 |
| Agent CLI                    | The `lcode` terminal interface, which also provides the Agent runtime for Desktop and Web | `pnpm --filter @lcode/cli dev` |

## Community Enhancements

This fork adds several features on top of upstream LCode (details in the [Chinese README](README.md)):

- **Agent memory (workspace memory)** — per-workspace persistent memory stored as plain local Markdown (`MEMORY.md` index plus item files). The Agent reads and writes it across sessions to recall project conventions, preferences, and context. Toggle it in onboarding or Settings; turning it off stops all reads and writes.
- **Dynamic workflows** — the Agent can orchestrate multi-step tasks into workflows with typed fan-out, loops, and conditional branches via the built-in `CreateWorkflow` tool. Workflows run on parallel sub-agent (actor) lanes, and **each lane can use its own AI provider and model** (or inherit the session default), with per-lane thought-level and speed controls. Regular tasks can also pick a provider/model per task, mixing models to match capability and cost. Frequently used workflows are saved under the workspace `.lcode/workflows/` directory and can be re-run by name; the Automation panel shows live progress. Approval boundaries are unchanged: sensitive steps still go through per-step permission prompts.
- **Mobile remote control (desktop mirroring)** — pair your phone by scanning a QR code or opening a pairing link. After two-way authorization the phone gets the full client UI, not a read-only thumbnail. The desktop only makes outbound connections through a Cloudflare Worker tunnel that stores no task data; pairing uses one-time capabilities plus on-desktop confirmation, device credentials are revocable, and reconnects after network drops resume automatically. Tunnel source: [cfworker-remote/](cfworker-remote/).
- **Self-built Computer Use runtime** — the upstream Computer Use implementation was **not open-sourced**; the public repository only shipped a basic nut-js fallback. `packages/lcode-cua` is a full self-built replacement: a dedicated Helper process that executes a 14-method Computer Use contract over a capability-checked broker (fail-closed on denied permissions). It reads real UIA (Windows) / AX (macOS) / AT-SPI (Linux) application trees via `@crowecawcaw/xa11y`, captures window screenshots with application/window bindings so coordinate actions cannot silently retarget after focus changes, and ships native Linux builds (x64 / arm64) from CI.

## Setup

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/lcode-cli/](apps/lcode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Additional setup and build commands:

| Command                        | Purpose                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                                                                |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets, including remote assets by default                                                                  |
| `pnpm prepare:remote-assets`   | Prepare remote runtime assets separately                                                                                            |
| `pnpm bootstrap:with-remote`   | Set up dependencies and local and remote assets, then build the relevant packages sequentially; skip the desktop application bundle |
| `pnpm build`                   | Recursively run each workspace package's build script, including its asset preparation steps                                        |

The default `bootstrap` skips remote asset preparation and is suitable for local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote distribution assets.

## Development and Usage

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and uses production service configuration. The startup script prepares local runtime assets, builds the desktop Agent, then starts Electron and source watchers.

Set `LCODE_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS / Linux:

```bash
LCODE_DATA_BASE_DIR="$HOME/.lcode-dev-home" pnpm dev:desktop:test
```

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
LCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and general `/api` requests are proxied to the local backend; `/api/v1/oauth/token` is proxied separately to the configured product service.

After changing Agent source code, run `pnpm --filter @lcode/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → LCode CLI distribution below.

### LCode CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `lcode` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
lcode

# Start the Web interface
lcode --web

# Set the project and port without opening a browser automatically
lcode --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
lcode --help
lcode --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `LCODE_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option.

See Packaging below for build instructions. `pnpm build:lcode` only creates the distribution; it does not replace an existing `lcode` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v lcode` on macOS / Linux or `where.exe lcode` on Windows.

### CLI Source Development

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @lcode/cli dev --help
pnpm --filter @lcode/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @lcode/cli... build
node apps/lcode-cli/packages/cli/dist/lcode.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/lcode.mjs` shown below to test the unified command.

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`. Select the Desktop development environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `LCODE_DATA_BASE_DIR`                | Base directory for application data, stored under its `.lcode/` subdirectory            |
| `LCODE_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                      |
| `LCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset |
| `LCODE_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

## Packaging

See [third-party/README.md](third-party/README.md) for notice generation, distribution checks, and where the notices are included in each distribution.

### Desktop

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts `mac`, `win`, or `linux`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

### LCode CLI distribution

Run `pnpm build:lcode` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `LCODE_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:lcode --base-url https://downloads.example.com/lcode/

# When LCODE_DIST_BASE_URL is already configured
pnpm build:lcode

# Repackage existing Agent, backend, and Web build outputs
pnpm build:lcode --skip-build

# Show options for the version, output directory, and more
pnpm build:lcode --help
```

The version defaults to the root `package.json` version. Output is written to `dist/lcode/`:

- `releases/<version>/lcode-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.lcode/runtime` by default, and creates the `lcode` command in `~/.local/bin`. Override these directories with `LCODE_DIST_HOME` and `LCODE_DIST_BIN_DIR`, respectively.

Existing Lite users should switch to the new build command, environment variables, and installer. Installation does not remove old Lite directories or migrate/delete session data.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
lcode_version=$(node -p "require('./dist/lcode/latest.json').version")
mkdir -p dist/lcode/debug
tar -xzf "dist/lcode/releases/$lcode_version/lcode-$lcode_version.tar.gz" \
  -C dist/lcode/debug
# Start the TUI by default
node dist/lcode/debug/lcode/bin/lcode.mjs

# Start Web mode
node dist/lcode/debug/lcode/bin/lcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

| Directory                                            | Responsibility                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging                                    |
| `packages/web`                                       | Web client                                                                              |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                                        |
| `packages/lcode-server-cli`                          | Standalone server startup and process management                                        |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                                       |
| `packages/services`                                  | Business services and persistence                                                       |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols and types, RPC framework, and Agent client SDK                         |
| `packages/provider`, `packages/provider-node`        | Common provider capabilities and Node implementations                                   |
| `apps/lcode-cli`                                     | Agent CLI, TUI, runtime, and tools                                                      |
| `scripts`, `config`, `third-party`                   | Build and maintenance scripts, built-in configuration, and third-party notice materials |

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information.
