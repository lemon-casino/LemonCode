# Fixed Magpie provider plugins

Runtime sources are copied verbatim from the commit and package versions in `manifest.json`. SHA-256 records cover every transitive module. `LICENSE` and package-specific `LICENSE*` files retain upstream attribution; the worker generator also embeds all notices in its distributable source.

The worker includes the locally adapted Google protocol helper from `native/google-wire.ts`, so its generated notice also retains `native/LICENSE.magpie`; see `native/README.md` for its pinned magpie source and adaptation scope. The vendor snapshot, package-specific notices, generated worker, and native adaptation are registered in `third-party/copied-components.json` for the complete Desktop/CLI distribution notices. The Qoder notice preserves the CLIProxyAPI attribution carried by the pinned plugin revision without claiming an unknown original CLIProxyAPI import commit.

The `.mjs.source` suffix keeps immutable third-party modules outside TypeScript and lint. Production imports only the generated `plugins/worker-source.ts`; it never reads an adjacent Magpie checkout, installs a plugin, or executes an installation script. Each driver owns a disposable Node worker with its own module state. Only the host owns durable credentials and accepts credential writes for a live operation and account generation.

To intentionally reproduce this pinned source, from the repository root:

```sh
node scripts/sync-auth-plugin-vendor.mjs /path/to/pinned/plugins-checkout
node scripts/build-auth-plugin-worker.mjs
pnpm exec tsx --test packages/provider-node/src/provider-auth/plugins/fixtures.test.ts
```

The source checkout must be clean at the recorded revision. The generator verifies all hashes before embedding. Rebuild the worker whenever the compatibility sources or the shared Google wire converter change. Run these commands explicitly during maintenance; neither command belongs in the login lifecycle.

The fixed execution boundary supports the upstream `config`, `auth.methods`, `authorize/callback`, `loader`, `refresh`, `usage`, `provider.models` and `chat.headers` hooks. Host session identity is translated from `x-lcode-session-id` into provider-specific headers and removed before network IO. Root account persistence remains generation-checked; credential reads/writes from cancelled operations are rejected. Model requests have per-request cancellation; authorization cancellation disposes callback servers and CLI children with its worker.

External CLI methods retain their actual dependency (for example Grok Build); an unavailable executable returns the upstream installation/sign-in error. Explicit import methods retain their actual CLI/desktop file formats. Those files are never read just to enumerate login methods. Fixed upstream modules may use synchronous native/file calls inside their isolated worker; host-owned persistence and transport are asynchronous.

Fixtures exercise real bundled callbacks and transports against loopback endpoints. They are not evidence of successful authorization to a real vendor account. `createPluginAuthFixtureDriver` is an internal test entry and is not exported from the package public API.
