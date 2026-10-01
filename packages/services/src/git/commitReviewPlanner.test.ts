import assert from "node:assert/strict";
import test from "node:test";
import { planSessionCommits } from "./commitReviewPlanner.js";

const file = (headContent: string | null, content: string | null, path = "x.txt") => ({
  path,
  headContent,
  content,
  mode: "100644",
});
const mutation = (
  sessionId: string,
  beforeContent: string | null,
  afterContent: string | null,
  path = "x.txt",
  id = sessionId,
) => ({
  id,
  sessionId,
  path,
  beforeContent,
  afterContent,
  toolName: "Edit",
  createdAt: 1,
});

test("同文件 A/B 不同区域：候选按已验证版本链拆分，最终不漏改动", () => {
  const base = "a\nb\n";
  const a = "A\nb\n";
  const b = "A\nB\n";
  const plan = planSessionCommits([file(base, b)], {
    complete: true,
    mutations: [mutation("A", base, a), mutation("B", a, b)],
  });
  assert.equal(plan.mode, "ordered");
  assert.deepEqual(
    plan.groups.map((group) => group.sessionIds),
    [["A"], ["B"]],
  );
  assert.equal(plan.groups[0]?.files[0]?.content, a);
  assert.equal(plan.groups[1]?.files[0]?.headContent, a);
  assert.equal(plan.groups[1]?.files[0]?.content, b);
});

test("同一行 A 后 B 增强：保留中间版本与提交依赖", () => {
  const plan = planSessionCommits([file("v1\n", "v3\n")], {
    complete: true,
    mutations: [mutation("A", "v1\n", "v2\n"), mutation("B", "v2\n", "v3\n")],
  });
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups[0]?.files[0]?.content, "v2\n");
  assert.deepEqual(plan.groups[1]?.dependsOn, [plan.groups[0]?.id]);
});

test("不同文件的会话可独立分组", () => {
  const plan = planSessionCommits([file("x", "X", "x.txt"), file("y", "Y", "y.txt")], {
    complete: true,
    mutations: [mutation("A", "x", "X", "x.txt"), mutation("B", "y", "Y", "y.txt")],
  });
  assert.equal(plan.mode, "split");
  assert.equal(plan.groups.length, 2);
  assert.ok(plan.groups.every((group) => group.dependsOn.length === 0));
});

test("A → B → A 的会话依赖环合并，不猜测拆分", () => {
  const plan = planSessionCommits([file("0", "3")], {
    complete: true,
    mutations: [
      mutation("A", "0", "1", "x.txt", "a1"),
      mutation("B", "1", "2"),
      mutation("A", "2", "3", "x.txt", "a2"),
    ],
  });
  assert.equal(plan.mode, "merged");
  assert.ok(plan.warnings.includes("dependency-cycle"));
  assert.equal(plan.groups[0]?.files[0]?.content, "3");
});

for (const scenario of ["missing", "external", "fork", "incomplete", "bash"] as const) {
  test(`证据不足 ${scenario}：合并整个选择范围且要求人工确认`, () => {
    const mutations =
      scenario === "missing"
        ? []
        : scenario === "external"
          ? [mutation("A", "0", "1")]
          : scenario === "fork"
            ? [mutation("A", "0", "2"), mutation("B", "0", "other")]
            : [{ ...mutation("A", "0", "2"), toolName: scenario === "bash" ? "Bash" : "Edit" }];
    const plan = planSessionCommits([file("0", "2")], {
      complete: scenario !== "incomplete",
      mutations,
    });
    assert.equal(plan.mode, "merged");
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0]?.requiresConfirmation, true);
    assert.equal(plan.groups[0]?.files[0]?.content, "2");
  });
}

test("新建/删除/CRLF/无末尾换行保留准确内容", () => {
  for (const [before, after] of [
    [null, "new\r\n"],
    ["old", null],
    ["a\r\n", "b\r\n"],
    ["a", "b"],
  ] as const) {
    const plan = planSessionCommits([file(before, after)], {
      complete: true,
      mutations: [mutation("A", before, after)],
    });
    assert.equal(plan.groups[0]?.files[0]?.content, after);
    assert.equal(plan.groups[0]?.files[0]?.headContent, before);
  }
});

test("重复同一条证据幂等，不因重复消息制造分叉", () => {
  const event = mutation("A", "0", "1");
  const plan = planSessionCommits([file("0", "1")], { complete: true, mutations: [event, event] });
  assert.equal(plan.mode, "split");
  assert.equal(plan.groups.length, 1);
});

test("同一事件 id 的不同内容不能靠覆盖去重伪造完整证据", () => {
  const event = mutation("A", "0", "1");
  const plan = planSessionCommits([file("0", "2")], {
    complete: true,
    mutations: [event, { ...event, afterContent: "2" }],
  });
  assert.equal(plan.mode, "merged");
});

test("A 新建后 B 增强：第二组文件模式锚定中间版本，而非最初 HEAD", () => {
  const plan = planSessionCommits([{ ...file(null, "enhanced"), headMode: null }], {
    complete: true,
    mutations: [mutation("A", null, "initial"), mutation("B", "initial", "enhanced")],
  });
  assert.equal(plan.groups[0]?.files[0]?.headMode, null);
  assert.equal(plan.groups[1]?.files[0]?.headMode, "100644");
});
