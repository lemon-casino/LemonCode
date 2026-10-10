import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCheckoutPathWithin, isOwnedCheckoutScope } from "./ownedCheckoutScope.js";

test("Windows checkout boundaries handle separators, case, siblings, traversal, and other drives", () => {
  for (const child of [
    "C:\\checkout",
    "c:/CHECKOUT/packages/server",
    "C:\\checkout\\child\\..\\server",
  ])
    assert.equal(isCheckoutPathWithin("C:\\checkout", child, "win32"), true, child);
  for (const child of [
    "C:\\checkout-other",
    "C:\\checkout\\..\\outside",
    "D:\\checkout",
    "\\\\server\\share\\checkout",
  ])
    assert.equal(isCheckoutPathWithin("C:\\checkout", child, "win32"), false, child);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} checkout boundaries use complete POSIX path segments and preserve canonical case`, () => {
    for (const child of ["/checkout", "/checkout/packages/server", "/checkout/a/../server"])
      assert.equal(isCheckoutPathWithin("/checkout", child, platform), true, child);
    for (const child of [
      "/checkout-other",
      "/checkout/../outside",
      "/CHECKOUT/server",
      "/outside/checkout",
    ])
      assert.equal(isCheckoutPathWithin("/checkout", child, platform), false, child);
  });
}

test("missing descendants retain canonical ancestor and identity checks on deletion retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-checkout-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  await mkdir(checkout);
  await mkdir(outside);
  await symlink(
    outside,
    join(checkout, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const binding = { checkoutPath: checkout, workspaceIdentity: "execution-a" };
  assert.equal(
    await isOwnedCheckoutScope(binding, {
      workspacePath: join(checkout, "absent", "child"),
      workspaceIdentity: " execution-a ",
    }),
    true,
  );
  assert.equal(
    await isOwnedCheckoutScope(binding, {
      workspacePath: join(checkout, "linked", "absent"),
      workspaceIdentity: "execution-a",
    }),
    false,
  );
  assert.equal(
    await isOwnedCheckoutScope(binding, {
      workspacePath: checkout,
      workspaceIdentity: "execution-b",
    }),
    false,
  );
});
