import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  McpSyncCandidate,
  McpSyncExportResult,
  McpSyncImportResult,
  PluginSyncArchiveExportResult,
  PluginSyncCandidate,
  PluginSyncImportResult,
  RemoteTarget,
  SkillSyncArchiveExportResult,
  SkillSyncCandidate,
  SkillSyncImportResult,
} from "@lcode/shared";
import type { IMcpSyncService, IPluginSyncService, ISkillSyncService } from "@lcode/services";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { RemoteMcpSyncDialog } from "@/settings/RemoteMcpSyncDialog.js";
import { RemotePluginSyncDialog } from "@/settings/RemotePluginSyncDialog.js";
import { RemoteSkillSyncDialog } from "@/settings/RemoteSkillSyncDialog.js";
import "@lcode/ui/styles.css";

// C03：三类远端同步面板的复选框迁移契约。三个弹窗都挂真实组件，只注入同步服务 mock；
// 选择集合、过滤与提交时序全部由弹窗自身维护，fixture 只记录导出/导入调用。
const query = new URLSearchParams(location.search);
const scenario = query.get("scenario") ?? "mcp";
// empty=1 时所有本地候选都标记为远端已存在，覆盖「零可选项」分支。
const emptyOnly = query.has("empty");

const bridge = {
  mcp: {
    exports: [] as Array<{ serverIds: string[] }>,
    imports: [] as Array<{ servers: Array<{ name: string }>; overwrite?: boolean }>,
  },
  plugin: {
    exports: [] as Array<{ pluginIds: string[] }>,
    imports: [] as Array<{ overwrite?: boolean }>,
  },
  skill: {
    exports: [] as Array<{ skillIds: string[] }>,
    imports: [] as Array<{ overwrite?: boolean }>,
  },
};
Object.assign(window, { __sync: bridge });

const remoteTarget: RemoteTarget = {
  kind: "ssh",
  host: "fixture.example",
  username: "fixture",
  port: 22,
};

const mcpCandidates: McpSyncCandidate[] = [
  {
    id: "mcp-notes",
    name: "Notes Server",
    config: { command: "node", args: ["notes.js"] },
    enabled: true,
    source: "zcode",
    path: "/fixture/.zcode/mcp/notes.json",
  },
  {
    id: "mcp-search",
    name: "Search Server",
    config: { url: "https://search.example.invalid/mcp" },
    enabled: true,
    source: "zcode",
    path: "/fixture/.zcode/mcp/search.json",
  },
  {
    id: "mcp-legacy",
    name: "Legacy Server",
    config: { command: "legacy" },
    enabled: true,
    source: "agents",
    path: "/fixture/.zcode/mcp/legacy.json",
  },
];
const skillCandidates: SkillSyncCandidate[] = [
  {
    id: "skill-review",
    name: "Review Skill",
    directoryName: "review-skill",
    description: "代码审查技能",
    path: "/fixture/.lcode/skills/review-skill",
    sizeBytes: 2048,
  },
  {
    id: "skill-slides",
    name: "Slides Skill",
    directoryName: "slides-skill",
    description: "幻灯片技能",
    path: "/fixture/.lcode/skills/slides-skill",
    sizeBytes: 4096,
  },
  {
    id: "skill-legacy",
    name: "Legacy Skill",
    directoryName: "legacy-skill",
    description: "已存在技能",
    path: "/fixture/.lcode/skills/legacy-skill",
    sizeBytes: 1024,
  },
];
const pluginCandidates: PluginSyncCandidate[] = [
  {
    id: "plugin-notes",
    name: "Notes Plugin",
    pluginId: "notes-plugin",
    directoryName: "notes-plugin",
    path: "/fixture/.lcode/plugins/notes-plugin",
    sizeBytes: 2048,
    enabled: true,
    componentTypes: ["commands"],
  },
  {
    id: "plugin-slides",
    name: "Slides Plugin",
    pluginId: "slides-plugin",
    directoryName: "slides-plugin",
    path: "/fixture/.lcode/plugins/slides-plugin",
    sizeBytes: 4096,
    enabled: true,
    componentTypes: ["skills"],
  },
  {
    id: "plugin-legacy",
    name: "Legacy Plugin",
    pluginId: "legacy-plugin",
    directoryName: "legacy-plugin",
    path: "/fixture/.lcode/plugins/legacy-plugin",
    sizeBytes: 1024,
    enabled: true,
    componentTypes: ["commands"],
  },
];

const writeAccess = { ok: true, path: "/fixture/remote-home" };

const localMcpSyncService = {
  listLocalUserMcpCandidates: async () => ({
    candidates: mcpCandidates,
    localHomeDir: "/fixture/home",
  }),
  exportMcpServers: async ({
    serverIds,
  }: {
    serverIds: string[];
  }): Promise<McpSyncExportResult> => {
    bridge.mcp.exports.push({ serverIds: [...serverIds] });
    return {
      servers: serverIds.map((id) => {
        const candidate = mcpCandidates.find((item) => item.id === id);
        if (!candidate) throw new Error(`unknown mcp candidate ${id}`);
        return {
          id: candidate.id,
          name: candidate.name,
          config: candidate.config,
          enabled: candidate.enabled,
          source: candidate.source,
          path: candidate.path,
        };
      }),
      localHomeDir: "/fixture/home",
    };
  },
} as unknown as IMcpSyncService;

const remoteMcpSyncService = {
  listRemoteUserMcpStatuses: async ({ names }: { names: string[] }) => ({
    statuses: names.map((name) => ({
      name,
      exists: emptyOnly ? true : name === "Legacy Server",
    })),
    remoteHomeDir: "/fixture/remote-home",
  }),
  checkRemoteUserMcpWriteAccess: async () => writeAccess,
  importMcpServers: async (params: {
    servers: McpSyncExportResult["servers"];
    overwrite?: boolean;
  }): Promise<McpSyncImportResult> => {
    bridge.mcp.imports.push({
      servers: params.servers.map((server) => ({ name: server.name })),
      overwrite: params.overwrite,
    });
    return {
      results: params.servers.map((server) => ({ name: server.name, status: "synced" as const })),
    };
  },
} as unknown as IMcpSyncService;

const localSkillSyncService = {
  listLocalUserSkillCandidates: async () => ({
    candidates: skillCandidates,
    maxArchiveBytes: 8 * 1024 * 1024,
  }),
  exportSkillsArchive: async ({
    skillIds,
  }: {
    skillIds: string[];
  }): Promise<SkillSyncArchiveExportResult> => {
    bridge.skill.exports.push({ skillIds: [...skillIds] });
    return {
      archive: new Uint8Array([1, 2, 3]),
      archiveBytes: 3,
      skills: skillIds.map((id) => {
        const candidate = skillCandidates.find((item) => item.id === id);
        if (!candidate) throw new Error(`unknown skill candidate ${id}`);
        return { id: candidate.id, name: candidate.name, directoryName: candidate.directoryName };
      }),
    };
  },
} as unknown as ISkillSyncService;

const remoteSkillSyncService = {
  listRemoteUserSkillStatuses: async ({ directoryNames }: { directoryNames: string[] }) => ({
    statuses: directoryNames.map((directoryName) => ({
      directoryName,
      exists: emptyOnly ? true : directoryName === "legacy-skill",
    })),
  }),
  checkRemoteUserSkillWriteAccess: async () => writeAccess,
  importSkillsArchive: async (params: { overwrite?: boolean }): Promise<SkillSyncImportResult> => {
    const exported = bridge.skill.exports.at(-1);
    if (!exported) throw new Error("export must run before import");
    bridge.skill.imports.push({ overwrite: params.overwrite });
    return {
      results: exported.skillIds.map((id) => {
        const candidate = skillCandidates.find((item) => item.id === id);
        return {
          name: candidate?.name ?? id,
          directoryName: candidate?.directoryName ?? id,
          status: "synced" as const,
        };
      }),
    };
  },
} as unknown as ISkillSyncService;

const localPluginSyncService = {
  listLocalUserPluginCandidates: async () => ({
    candidates: pluginCandidates,
    maxArchiveBytes: 8 * 1024 * 1024,
  }),
  exportPluginsArchive: async ({
    pluginIds,
  }: {
    pluginIds: string[];
  }): Promise<PluginSyncArchiveExportResult> => {
    bridge.plugin.exports.push({ pluginIds: [...pluginIds] });
    return {
      archive: new Uint8Array([4, 5]),
      archiveBytes: 2,
      plugins: pluginIds.map((id) => {
        const candidate = pluginCandidates.find((item) => item.id === id);
        if (!candidate) throw new Error(`unknown plugin candidate ${id}`);
        return {
          id: candidate.id,
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName: candidate.directoryName,
          enabled: candidate.enabled,
        };
      }),
    };
  },
} as unknown as IPluginSyncService;

const remotePluginSyncService = {
  listRemoteUserPluginStatuses: async ({
    plugins,
  }: {
    plugins: Array<{ pluginId: string; directoryName: string }>;
  }) => ({
    statuses: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      directoryName: plugin.directoryName,
      exists: emptyOnly ? true : plugin.pluginId === "legacy-plugin",
    })),
  }),
  checkRemoteUserPluginWriteAccess: async () => writeAccess,
  importPluginsArchive: async (params: {
    archive: Uint8Array;
    overwrite?: boolean;
  }): Promise<PluginSyncImportResult> => {
    const exported = bridge.plugin.exports.at(-1);
    if (!exported) throw new Error("export must run before import");
    bridge.plugin.imports.push({ overwrite: params.overwrite });
    return {
      results: exported.pluginIds.map((id) => {
        const candidate = pluginCandidates.find((item) => item.id === id);
        return {
          name: candidate?.name ?? id,
          pluginId: candidate?.pluginId ?? id,
          directoryName: candidate?.directoryName ?? id,
          status: "synced" as const,
        };
      }),
    };
  },
} as unknown as IPluginSyncService;

function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main className="min-h-dvh bg-background p-4 text-ui-base text-foreground">
      <div data-testid="fixture-ready" className="h-px w-px" />
      {scenario === "mcp" ? (
        <RemoteMcpSyncDialog
          open={open}
          onOpenChange={setOpen}
          localMcpSyncService={localMcpSyncService}
          remoteMcpSyncService={remoteMcpSyncService}
          remoteTarget={remoteTarget}
          workspacePath="/fixture/workspace"
          localWorkspacePath="/fixture/workspace"
          onSynced={() => {}}
        />
      ) : null}
      {scenario === "plugin" ? (
        <RemotePluginSyncDialog
          open={open}
          onOpenChange={setOpen}
          localPluginSyncService={localPluginSyncService}
          remotePluginSyncService={remotePluginSyncService}
          remoteTarget={remoteTarget}
          workspacePath="/fixture/workspace"
          localWorkspacePath="/fixture/workspace"
          onSynced={() => {}}
        />
      ) : null}
      {scenario === "skill" ? (
        <RemoteSkillSyncDialog
          open={open}
          onOpenChange={setOpen}
          localSkillSyncService={localSkillSyncService}
          remoteSkillSyncService={remoteSkillSyncService}
          remoteTarget={remoteTarget}
          workspacePath="/fixture/workspace"
          onSynced={() => {}}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </LCodeIntlProvider>,
);
