import { writeFile } from "node:fs/promises";
import { TASKS } from "./fixtures.mjs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const task = TASKS.find((task) => prompt.includes(`TASK_ID=${task.id}\n`));
if (!task) throw new Error("fixture missing");
const mode = process.env.LCODE_BENCH_FAKE_MODE;
if (mode === "hang") await new Promise(() => setInterval(() => {}, 1000));
if (mode === "flood") process.stdout.write("x".repeat(100000));
await writeFile(
  "answer.mjs",
  mode === "wrong"
    ? "export const invalid=true;"
    : mode === "exit-zero"
      ? "process.exit(0);"
      : task.solution,
);
if (mode === "tamper") await writeFile("verify.mjs", "// altered fixture checks\n");
if (mode !== "missing")
  process.stdout.write(
    JSON.stringify({ type: "result", response: "Synthetic fixture completed." }) + "\n",
  );
