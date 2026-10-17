import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProjectMember } from "@lcode/shared";
const labels = {
  connectionChanged: [
    "来源连接已变化，请重新选择目录。",
    "The source connection changed. Choose the folder again.",
  ],
  title: ["编辑项目", "Edit project"],
  name: ["项目名称", "Project name"],
  folders: ["源文件夹", "Source folders"],
  add: ["添加目录", "Add folder"],
  dropHint: ["可将多个文件夹拖入此弹框", "Drop multiple folders into this dialog"],
  addHint: ["点击添加目录", "Choose Add folder"],
  chooseFolder: ["选择此目录", "Choose this folder"],
  fromProject: ["从已有项目选择", "From projects"],
  noAvailableFolders: ["没有可选择的其它项目目录", "No other project folders available"],
  primary: ["主要", "Primary"],
  primaryHint: [
    "主目录是历史会话的身份锚点，不能在普通编辑中移除。",
    "The primary folder anchors existing chats and cannot be removed here.",
  ],
  frontend: ["前端", "Frontend"],
  backend: ["后端", "Backend"],
  shared: ["公共协议", "Shared"],
  test: ["测试", "Tests"],
  docs: ["文档", "Docs"],
  unspecified: ["未设置", "Not set"],
  purpose: ["用途和说明", "Purpose"],
  purposePlaceholder: [
    "例如：前端页面与交互，或后端接口与数据存储。",
    "For example: frontend pages and interactions, or backend APIs and storage.",
  ],
  defaultMember: ["默认参与", "Include by default"],
  included: ["参与", "Included"],
  excluded: ["不参与", "Excluded"],
  scopeHint: [
    "普通会话的下一轮输入使用保存后的范围。已接受的输入和已有工作树、工作集保留原范围。",
    "The next input in a regular chat uses the saved scope. Accepted inputs and existing worktrees or collaboration sets retain their scope.",
  ],
  local: ["本地", "Local"],
  remote: ["远程", "Remote"],
  disconnected: ["尚未连接，已保留目录配置", "Disconnected; saved folders are retained"],
  checking: ["检查目录…", "Checking folder…"],
  ready: ["目录可用", "Folder available"],
  remove: ["移除目录", "Remove folder"],
  saved: ["项目已保存", "Project saved"],
  failed: ["项目保存失败，草稿已保留", "Could not save project. Draft retained"],
  duplicate: ["该目录已在项目中", "This folder is already included"],
  limit: ["每个项目最多 20 个目录", "A project supports up to 20 folders"],
  noSelection: ["至少保留一个默认参与的目录", "Include at least one folder in new chats"],
  missing: [
    "项目已被移除，请关闭后重新选择。草稿仍保留。",
    "This project was removed. Your draft is retained; close and choose a project again.",
  ],
  unavailable: [
    "此 Host 尚不支持项目编辑，请更新对应 Host 后重试。",
    "This Host does not support project editing yet. Update the Host and retry.",
  ],
  latest: ["最新项目", "Latest project"],
  editExisting: ["放弃草稿并编辑已有项目", "Discard draft and edit existing project"],
  reload: ["重新读取此项目", "Reload this project"],
  affected: ["目录", "folders"],
} as const;
export function useProjectEditorText() {
  const { locale } = useLCodeIntl();
  return (key: keyof typeof labels) => labels[key][locale === "zh-CN" ? 0 : 1];
}

export const PROJECT_PRESET_ROLES = ["frontend", "backend", "shared", "test", "docs"] as const;
export function isPresetProjectRole(role: string): role is (typeof PROJECT_PRESET_ROLES)[number] {
  return PROJECT_PRESET_ROLES.some((preset) => preset === role);
}
export function useProjectRoleText() {
  const text = useProjectEditorText();
  return (role: string) =>
    isPresetProjectRole(role)
      ? text(role)
      : !role || role === "custom"
        ? text("unspecified")
        : role;
}

/** 中文依据：旧用途名称和细节合并回填，不能只保留其中一项；新说明已经含前缀时不重复。 */
export function formatProjectMemberPurpose(
  member: Pick<ProjectMember, "role" | "description">,
  roleText: (role: string) => string,
): string {
  const description = member.description.trim();
  const role = member.role && member.role !== "custom" ? roleText(member.role) : "";
  if (!role || description === role || description.startsWith(`${role}\n`)) return description;
  return [role, description].filter(Boolean).join("\n");
}
