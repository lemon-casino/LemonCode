import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";
import { assertProductionGraphs, missingProductionPackages } from "./third-party-npm.mjs";

const workspace = YAML.parse(
  await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
);
const lockfile = YAML.parse(await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
const current = { os: "linux", cpu: "x64", libc: "glibc" };
const policy = {
  packages: lockfile.packages,
  snapshots: lockfile.snapshots,
  supportedArchitectures: workspace.supportedArchitectures,
  current,
};
const canvas = "@napi-rs/canvas";
const gnu = "@napi-rs/canvas-linux-arm64-gnu";
const musl = "@napi-rs/canvas-linux-arm64-musl";
const version = "0.1.100";
const dependency = (extra = {}) => ({ version, ...extra });
const projects = (dependencies, optionalDependencies) => [
  { name: "fixture", dependencies, optionalDependencies },
];
const canvasGraph = (includeMusl = true) =>
  projects({
    [canvas]: dependency({
      dependencies: {
        [gnu]: dependency(),
        ...(includeMusl ? { [musl]: dependency() } : {}),
      },
    }),
  });
const installed = (...names) => new Map(names.map((name) => [`${name}@${version}`, {}]));

test("Linux glibc release permits absent musl optional packages in both graph and disk checks", () => {
  for (const actual of [canvasGraph(), canvasGraph(false)]) {
    const required = assertProductionGraphs(canvasGraph(), actual, policy);
    assert.deepEqual(missingProductionPackages(required, installed(canvas, gnu)), [
      { name: musl, version },
    ]);
    assert.deepEqual(missingProductionPackages(required, installed(canvas, gnu, musl)), []);
  }
});

test("configured cross-architecture glibc packages remain required", () => {
  const required = assertProductionGraphs(canvasGraph(), canvasGraph(), policy);
  assert.throws(
    () => missingProductionPackages(required, installed(canvas, musl)),
    /Missing installed dependency: @napi-rs\/canvas-linux-arm64-gnu/u,
  );
  assert.throws(
    () => assertProductionGraphs(canvasGraph(), projects({ [canvas]: dependency() }), policy),
    /Missing: @napi-rs\/canvas-linux-arm64-gnu/u,
  );
});

test("explicit musl support and current musl hosts require musl optional packages", () => {
  for (const overrides of [
    {
      supportedArchitectures: {
        ...policy.supportedArchitectures,
        libc: ["current", "glibc", "musl"],
      },
    },
    { current: { ...current, libc: "musl" } },
  ]) {
    const required = assertProductionGraphs(canvasGraph(), canvasGraph(), {
      ...policy,
      ...overrides,
    });
    assert.throws(
      () => missingProductionPackages(required, installed(canvas, gnu)),
      /Missing installed dependency: @napi-rs\/canvas-linux-arm64-musl/u,
    );
  }
});

test("an excluded optional subtree may be absent until another supported path requires it", () => {
  const child = "portable-child";
  const graph = projects(
    {},
    {
      [musl]: dependency({ dependencies: { [child]: dependency() } }),
    },
  );
  const required = assertProductionGraphs(graph, projects({}), policy);
  assert.deepEqual(missingProductionPackages(required, installed()), [
    { name: musl, version },
    { name: child, version },
  ]);
  for (const dependencies of [{ [child]: dependency() }, { [musl]: dependency() }]) {
    const mixed = projects(dependencies, graph[0].optionalDependencies);
    assert.throws(() => assertProductionGraphs(mixed, projects({}), policy), /Missing:/u);
    assert.throws(
      () => missingProductionPackages(assertProductionGraphs(mixed, mixed, policy), installed()),
      /Missing installed dependency/u,
    );
  }
});

test("required canvas packages have no package-name exemption", () => {
  const name = "@napi-rs/canvas-android-arm64";
  const graph = projects({ [name]: dependency() });
  assert.throws(() => assertProductionGraphs(graph, projects({}), policy), /Missing:/u);
  assert.throws(
    () => missingProductionPackages(assertProductionGraphs(graph, graph, policy), installed()),
    /Missing installed dependency/u,
  );
});

test("generic and unknown optional dependencies cannot silently disappear", () => {
  for (const name of ["portable-package", "unknown-platform-package"]) {
    const graph = projects({}, { [name]: dependency() });
    assert.throws(() => assertProductionGraphs(graph, projects({}), policy), /Missing:/u);
    assert.throws(
      () => missingProductionPackages(assertProductionGraphs(graph, graph, policy), installed()),
      /Missing installed dependency/u,
    );
  }
});

test("platform policies support current, negative conditions and alternate desktop hosts", () => {
  const name = "native-fixture";
  const graph = projects({}, { [name]: dependency() });
  for (const [constraints, supportedArchitectures, host, excluded] of [
    [{ os: ["!linux"] }, {}, current, true],
    [{ cpu: ["!x64"] }, {}, current, true],
    [{ os: ["darwin"], cpu: ["arm64"] }, {}, current, true],
    [{ os: ["any"] }, {}, current, false],
    [{ os: "linux" }, {}, current, false],
    [{ cpu: ["!arm64"] }, { cpu: ["x64", "arm64"] }, current, true],
    [{ os: ["!win32"] }, {}, { os: "darwin", cpu: "arm64" }, false],
    [{ os: ["win32"], cpu: ["arm64"] }, {}, { os: "win32", cpu: "arm64" }, false],
    [{ cpu: ["arm64"] }, { cpu: ["current", "arm64"] }, current, false],
    [{ libc: ["musl"] }, {}, { os: "win32", cpu: "x64" }, false],
    [{ libc: ["musl"] }, { libc: ["glibc"] }, { os: "win32", cpu: "x64" }, false],
  ]) {
    const required = assertProductionGraphs(graph, graph, {
      packages: { [`${name}@${version}`]: constraints },
      supportedArchitectures,
      current: host,
    });
    if (excluded) assert.equal(missingProductionPackages(required, installed()).length, 1);
    else
      assert.throws(
        () => missingProductionPackages(required, installed()),
        /Missing installed dependency/u,
      );
  }
});

test("stale production versions remain blocking even for excluded optional platforms", () => {
  const actual = canvasGraph();
  actual[0].dependencies[canvas].dependencies[musl].version = "0.0.1";
  assert.throws(() => assertProductionGraphs(canvasGraph(), actual, policy), /Stale:.*0\.0\.1/u);
});

test("workspace importer optional edges survive pnpm ls flattening", () => {
  const graph = [{ ...projects({ [musl]: dependency() })[0], path: "/fixture" }];
  const required = assertProductionGraphs(graph, graph, {
    ...policy,
    workspaceRoot: "/fixture",
    importers: { ".": { optionalDependencies: { [musl]: { version } } } },
  });
  assert.deepEqual(missingProductionPackages(required, installed()), [{ name: musl, version }]);
});

test("peer snapshot variants cannot hide a required edge behind an optional edge", () => {
  const parent = "fixture-parent";
  const graph = projects({ [parent]: dependency({ dependencies: { [musl]: dependency() } }) });
  for (const peerSnapshots of [
    {
      [`${parent}@${version}(peer@1)`]: { optionalDependencies: { [musl]: version } },
      [`${parent}@${version}(peer@2)`]: { dependencies: { [musl]: version } },
    },
    {
      [`${parent}@${version}(peer@2)`]: { dependencies: { [musl]: version } },
      [`${parent}@${version}(peer@1)`]: { optionalDependencies: { [musl]: version } },
    },
  ]) {
    const required = assertProductionGraphs(graph, graph, { ...policy, snapshots: peerSnapshots });
    assert.throws(
      () => missingProductionPackages(required, installed(parent)),
      /Missing installed dependency/u,
    );
  }
});
