import assert from "node:assert/strict";
import test from "node:test";
import type { IGitBackupService, IServiceAccessor } from "@lcode/services";
import { buildRemoteWorkspaceSessionServices } from "./remoteWorkspaceSessionServices.js";

function createAccessor(gitBackupService?: IGitBackupService): IServiceAccessor {
  return { gitBackupService } as IServiceAccessor;
}

test("remote workspaces select the backup service on the remote filesystem", () => {
  const localBackup = {} as IGitBackupService;
  const remoteBackup = {} as IGitBackupService;
  const services = buildRemoteWorkspaceSessionServices(
    createAccessor(localBackup),
    createAccessor(remoteBackup),
  );

  assert.equal(services.gitBackupService, remoteBackup);
});

test("a remote Host without backup never falls back to the local backup owner", () => {
  const services = buildRemoteWorkspaceSessionServices(
    createAccessor({} as IGitBackupService),
    createAccessor(),
  );

  assert.equal(services.gitBackupService, undefined);
});
