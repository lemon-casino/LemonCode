import assert from "node:assert/strict";
import test from "node:test";
import type {
  IRuntimeEnvironmentService,
  IWorktreeService,
  IServiceAccessor,
} from "@lcode/services";
import { buildRemoteWorkspaceSessionServices } from "./remoteWorkspaceSessionServices.js";

test("remote execution selects both binding and environment owners, never the same-path local owner", () => {
  const local = {
    runtimeEnvironmentService: {} as IRuntimeEnvironmentService,
    worktreeService: {} as IWorktreeService,
  } as IServiceAccessor;
  const remote = {
    runtimeEnvironmentService: {} as IRuntimeEnvironmentService,
    worktreeService: {} as IWorktreeService,
  } as IServiceAccessor;
  const services = buildRemoteWorkspaceSessionServices(local, remote);
  assert.equal(services.runtimeEnvironmentService, remote.runtimeEnvironmentService);
  assert.equal(services.worktreeService, remote.worktreeService);
});

test("a remote Host without managed environments cannot fall back to local services", () => {
  const local = {
    runtimeEnvironmentService: {} as IRuntimeEnvironmentService,
    worktreeService: {} as IWorktreeService,
  } as IServiceAccessor;
  const services = buildRemoteWorkspaceSessionServices(local, {} as IServiceAccessor);
  assert.equal(services.runtimeEnvironmentService, undefined);
  assert.equal(services.worktreeService, undefined);
});
