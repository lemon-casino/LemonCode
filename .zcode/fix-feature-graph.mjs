// lcode-feature-graph.yaml 路径/符号镜像更新：代码侧改名后同步镜像；
// graphId 与 service.zcode-* 节点 ID 属 stableIdPolicy 管辖，保持不变（一次性）
import fs from "node:fs";

const p = ".agents/skills/feature-boundary-planner/references/lcode-feature-graph.yaml";
let c = fs.readFileSync(p, "utf8");
const before = c;

// 代码路径镜像（不会触及 service.zcode-* 节点 ID：均为带 src/ 或目录上下文的模式）
c = c.replaceAll("apps/zcode-cli/", "apps/lcode-cli/");
c = c.replaceAll("packages/shared/src/zcode-protocol-v4/", "packages/shared/src/lcode-protocol-v4/");
c = c.replaceAll("packages/shared/src/zcode-protocol/", "packages/shared/src/lcode-protocol/");
c = c.replaceAll("src/zcode-agent/", "src/lcode-agent/");
c = c.replaceAll("src/zcode-session/", "src/lcode-session/");
// 代码符号镜像
c = c.replaceAll("zcodeSessionRuntimePreferencesResultSchema", "lcodeSessionRuntimePreferencesResultSchema");
c = c.replaceAll("createZCodeAgentConnectionScope", "createLCodeAgentConnectionScope");
c = c.replaceAll("ZCodeAgentV4ClientMode", "LCodeAgentV4ClientMode");
c = c.replaceAll("ZCodeAgentConnectionScope", "LCodeAgentConnectionScope");
c = c.replaceAll("zcodeAgentConnectionScope", "lcodeAgentConnectionScope");

fs.writeFileSync(p, c);
console.log("changed:", c !== before);
// 残留自检：应只剩 graphId 与 service.zcode-* 节点 ID
const residual = c.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /zcode/i.test(l) && !/graphId|service\.zcode-/.test(l));
for (const [ln, l] of residual) console.log(`${ln}: ${l.trim().slice(0, 120)}`);
console.log("residual lines:", residual.length);
