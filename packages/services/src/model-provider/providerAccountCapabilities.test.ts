import assert from "node:assert/strict";
import test from "node:test";
import { createAuthDriver } from "@lcode/provider-node";
import { PROVIDER_AUTH_CHANNELS } from "./providerAccountStoreSchema.js";
test(
  "PC-05 all configured account channels negotiate single-attempt dispatch without OAuth/API configuration fallbacks",
  { timeout: 15000 },
  async () => {
    for (const channel of PROVIDER_AUTH_CHANNELS) {
      const driver = await createAuthDriver(channel.id);
      try {
        assert.equal(driver.routingSingleAttempt, true, channel.id);
        assert.ok((await driver.methods()).length, channel.id);
      } finally {
        await driver.dispose?.();
      }
    }
  },
);
