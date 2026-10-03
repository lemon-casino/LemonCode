import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "@lcode/shared/node";
import type { CheckoutCoordinator, WorktreeGitPort } from "../nodeTypes.js";
import type { CheckoutLease } from "../contract.js";
import { canonicalCheckoutPath } from "./git.js";

export class CheckoutBusyError extends Error {
  readonly code = "LCODE_CHECKOUT_BUSY";
}

export function createCheckoutCoordinator(options: {
  dataDir: string;
  git: WorktreeGitPort;
  waitMs?: number;
}): CheckoutCoordinator {
  const leases = new Map<string, { ownerId: string; key: string; release: () => Promise<void> }>();
  const pending = new Map<string, Promise<CheckoutLease>>();
  return {
    async acquire(params) {
      const workspacePath = await canonicalCheckoutPath(options.git, params.workspacePath);
      const key = createHash("sha256")
        .update(process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath)
        .digest("hex");
      const ownerKey = JSON.stringify([key, params.ownerId]);
      const existing = pending.get(ownerKey);
      if (existing) return existing;
      const acquiring = (async () => {
        const root = join(options.dataDir, "checkout-locks");
        await mkdir(root, { recursive: true });
        const release = await acquireFileLock(
          join(root, key),
          [50, 100, 200, 500],
          10_000,
          params.waitMs ?? options.waitMs ?? 30_000,
        );
        const token = randomUUID();
        leases.set(token, { ownerId: params.ownerId, key: ownerKey, release });
        return { token, ownerId: params.ownerId, workspacePath };
      })();
      pending.set(ownerKey, acquiring);
      try {
        return await acquiring;
      } catch (error) {
        pending.delete(ownerKey);
        if ((error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT")
          throw new CheckoutBusyError("Checkout is busy; wait for its current writer to finish");
        throw error;
      }
    },
    async release(params) {
      const lease = leases.get(params.token);
      if (!lease) return;
      if (lease.ownerId !== params.ownerId) throw new Error("Checkout lease owner does not match");
      await lease.release();
      leases.delete(params.token);
      pending.delete(lease.key);
    },
  };
}
