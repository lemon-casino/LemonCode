# Fixed provider compatibility

The worker bundles the pinned modules recorded in `../vendor/manifest.json`. It is
isolated per authorization attempt/account. Renderer input cannot select a module,
read a local path, provide credential callbacks, or access the fixture transport.

The local compatibility code preserves method metadata and safe model capability
facts, reports model-list fallback and sign-in state to the Host, and runs Factory
file imports through the existing authorization attempt. Plugin-owned grant fields
and imported file contents stay private to the Host worker.

Upstream-derived adaptations added outside the pinned directory:

| Local file                             | Exact source                                                                                | Revision / license                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `factory-import.mjs`                   | Magpie `internal/provider/factory_key.go` and pinned Factory `whoami` response/grant format | Magpie `93c5d846ca2b05ac8ca961956304104e5d112845`, MIT (`../native/LICENSE.magpie`) |
| `method-details.mjs` (`promptApplies`) | Magpie `internal/plugin/host.js`, `applies` / `nextPrompt`                                  | same Magpie revision and license                                                    |
| `zcode-local.mjs`                      | plugins `packages/zcode/index.mjs`, credential decryption and `ownSignIn` / `ownTeam`       | plugins `da7e2f67a5c7c2fe2ca776156d08ce2f144e86dd`, MIT (`../vendor/LICENSE`)       |

The ZCode adapter reads only the selected site's local source without modifying
the pinned module, process-wide environment, or external credential files. It
materializes that site into a `zcode-channel` grant for each actual operation.
Renewal follows only the same account, organization and project; identity changes
require detecting the account again, so usage cannot move into an old connection.
Signing out retains the pinned plugin's snapshot fallback.

The upstream-derived files listed above, as well as the generated worker, belong
to the copied component inventory. Regenerate the bundle with
`node scripts/build-auth-plugin-worker.mjs`, then regenerate and verify notices.
