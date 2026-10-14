import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// 使用桌面 tsup 实际依赖的编译器，避免 hoisted 的另一版 esbuild 掩盖生产序列化差异。
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

export const desktopRoot = resolve(import.meta.dirname, "..");

export async function cleanupFixtureDirectory(directory) {
  const cache = await realpath(join(desktopRoot, "node_modules/.cache"));
  const target = await realpath(directory);
  const child = relative(cache, target);
  if (!child || isAbsolute(child) || child.split(sep)[0] === "..")
    throw new Error("Fixture cleanup escaped its cache");
  await rm(target, { recursive: true, force: true });
}
const loggerStub = "export const logger={info(){},warn(){},debug(){},error(){}};";
const electronStub = `
export const handlers=new Map();
export const ipcMain={handle:(name,handler)=>handlers.set(name,handler)};
export const BrowserWindow={fromWebContents:()=>null};
export const app={getPath:()=>{throw Error('unexpected application path lookup')}};
export const dialog={showSaveDialog:async()=>({filePath:''})};
export const webContents={}, nativeImage={}, screen={}, session={}, MessageChannelMain={};
`;

export async function loadSource(t, relativePath, stubs = {}, compilerOptions = {}) {
  const cache = join(desktopRoot, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "main-boundary-test-"));
  t.after(() => cleanupFixtureDirectory(directory));
  const output = join(directory, "fixture.mjs");
  const source = resolve(desktopRoot, relativePath).replaceAll("\\", "/");
  await build({
    stdin: {
      contents: `export * from ${JSON.stringify(source)};import * as testElectron from 'electron';export {testElectron};`,
      resolveDir: desktopRoot,
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    ...compilerOptions,
    plugins: [
      {
        name: "main-boundary-adapters",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const stub =
              stubs[args.path] ??
              (args.path === "electron"
                ? electronStub
                : /(?:^|\/)logger\.js$/u.test(args.path)
                  ? loggerStub
                  : undefined);
            if (stub !== undefined)
              return { path: args.path, namespace: "adapter", pluginData: stub };
            if (args.path === "@lcode/shared")
              return { path: resolve(desktopRoot, "../shared/src/index.ts") };
            if (args.path === "@lcode/model-option-map")
              return { path: resolve(desktopRoot, "../model-option-map/src/index.ts") };
          });
          builder.onLoad({ filter: /.*/, namespace: "adapter" }, (args) => ({
            contents: args.pluginData,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(output).href);
}

export function loadMacUpdateRuntime(t) {
  const updateElectronStub = `
    import {EventEmitter} from 'node:events';
    export const events=[], controls={handoffFailure:false};
    export const updater=Object.assign(new EventEmitter(),{setFeedURL(){},checkForUpdates:async()=>null});
    export const handlers=new Map();
    export const ipcMain={handle:(name,handler)=>handlers.set(name,handler),on(){}};
    export const BrowserWindow={getAllWindows:()=>[]};
    export const Menu={getApplicationMenu:()=>null};
    export const net={};
    export const app={isPackaged:true,getVersion:()=> '3.18.6',getPath:()=> '/fixture',
      exit:code=>events.push('exit:'+code),quit:()=>{throw Error('must explicitly exit prepared Main')}};
  `;
  return loadSource(
    t,
    "src/main/autoUpdater.ts",
    {
      electron: updateElectronStub,
      "electron-updater": `
        import {updater} from 'electron'; export default {autoUpdater:updater};
        export class CancellationToken {dispose(){} createPromise(executor){return new Promise((resolve,reject)=>executor(resolve,reject,()=>{}))}}
      `,
      "./manifestUpdateProvider.js": `export class ManifestUpdateProvider{}; export const getElectronReleasePlatform=()=> 'darwin-aarch64';`,
      "./verifiedUpdateArtifact.js": `
        export const selectVerifiedUpdateArtifact=()=>({url:'https://fixture.invalid/LCode.dmg',fileName:'LCode.dmg',size:3,sha512:'fixture'});
        export const downloadVerifiedUpdateArtifact=async()=> '/fixture/verified-LCode.dmg';
      `,
      "./macUpdateInstall.js": `
        import {events,controls} from 'electron';
        export async function openMacUpdateDmgAfterExit(options){
          events.push('handoff:'+options.dmgPath);
          if(controls.handoffFailure) throw Error('helper spawn failed');
          options.exitApp();
        }
      `,
    },
    { define: { "process.platform": '"darwin"' } },
  );
}
