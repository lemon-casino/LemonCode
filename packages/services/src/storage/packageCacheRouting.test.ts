import assert from "node:assert/strict";
import test from "node:test";
import { createStorageService } from "./app/storageService.js";
import type { StorageCleanResult } from "@lcode/shared";

const empty: StorageCleanResult = { freedBytes: 0, deletedCount: 0, skippedCount: 0, failures: [] };
const root = { id: "home" as const, path: "/fixture", hasCustomDataBaseDir: false };
const make = (
  packageCache?: { clean(path: string): Promise<StorageCleanResult> },
  hasCustomDataBaseDir = false,
) =>
  createStorageService({
    roots: { resolveRoots: async () => [{ ...root, hasCustomDataBaseDir }] },
    scanRunner: {
      run: async () => {
        throw new Error("unexpected scan");
      },
    },
    cleaner: {
      listCandidates: async () => {
        throw new Error("pnpm must not enumerate generic delete candidates");
      },
      deleteFiles: async () => {
        throw new Error("pnpm must not use generic delete");
      },
    },
    packageCache,
  });
test("pnpm cleanup routes to the injected owner and migration copies remain protected", async () => {
  const paths: string[] = [];
  const port = {
    clean: async (path: string) => {
      paths.push(path);
      return { ...empty, freedBytes: 42, deletedCount: 1 };
    },
  };
  const service = make(port);
  const legacy = make(port, true);
  try {
    assert.equal((await service.clean({ rootId: "home", categoryId: "pnpmCache" })).freedBytes, 42);
    assert.deepEqual(await legacy.clean({ rootId: "home", categoryId: "pnpmCache" }), empty);
    assert.deepEqual(paths, [root.path]);
  } finally {
    service.dispose();
    legacy.dispose();
  }
});
test("missing pnpm owner fails closed and concurrent cleaning is rejected", async () => {
  const absent = make();
  try {
    assert.equal(
      (await absent.clean({ rootId: "home", categoryId: "pnpmCache" })).failures[0]?.code,
      "ETOOLUNAVAILABLE",
    );
  } finally {
    absent.dispose();
  }
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = make({
    clean: async () => {
      entered();
      await pending;
      return empty;
    },
  });
  try {
    const first = service.clean({ rootId: "home", categoryId: "pnpmCache" });
    await admission;
    await assert.rejects(service.clean({ rootId: "home", categoryId: "pnpmCache" }), /busy/);
    finish();
    await first;
  } finally {
    finish();
    service.dispose();
  }
});

test("cleanup invalidates an older scan still waiting for roots", async () => {
  let resolveRoots!: (value: (typeof root)[]) => void;
  const pendingRoots = new Promise<(typeof root)[]>((resolve) => {
    resolveRoots = resolve;
  });
  let resolutions = 0;
  let scans = 0;
  const service = createStorageService({
    roots: { resolveRoots: async () => (++resolutions === 1 ? pendingRoots : [root]) },
    scanRunner: {
      run: async () => {
        scans++;
        return { roots: [], errors: [] };
      },
    },
    cleaner: {
      listCandidates: async () => [],
      deleteFiles: async () => ({ freedBytes: 0, deletedCount: 0, failures: [] }),
    },
    packageCache: { clean: async () => empty },
  });
  try {
    const scanning = service.startScan();
    const superseded = assert.rejects(scanning, /superseded/);
    await service.clean({ rootId: "home", categoryId: "pnpmCache" });
    resolveRoots([root]);
    await superseded;
    assert.equal(scans, 0);
  } finally {
    resolveRoots([root]);
    service.dispose();
  }
});
