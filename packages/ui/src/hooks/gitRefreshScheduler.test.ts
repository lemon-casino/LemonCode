import assert from "node:assert/strict";
import test from "node:test";
import { createGitRefreshScheduler } from "./gitRefreshScheduler.js";

test("慢 Git 刷新串行且合并在途事件，已完成结果不会被新事件饿死", async () => {
  const pending: Array<(value: number) => void> = [];
  const inputs: boolean[] = [];
  const values: number[] = [];
  const scheduler = createGitRefreshScheduler({
    read: (extended: boolean) => {
      inputs.push(extended);
      return new Promise<number>((resolve) => pending.push(resolve));
    },
    onStart: () => {},
    onResult: (value: number) => values.push(value),
    onError: () => assert.fail("unexpected error"),
  });
  scheduler.request(false);
  scheduler.request(true);
  scheduler.request(false);
  assert.deepEqual(inputs, [false]);
  pending.shift()!(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(values, [1]);
  assert.deepEqual(inputs, [false, true]);
  pending.shift()!(2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(values, [1, 2]);
  scheduler.dispose();
});

test("切换所有者释放 scheduler 后忽略迟到响应和待处理刷新", async () => {
  let finish!: (value: number) => void;
  let starts = 0;
  const scheduler = createGitRefreshScheduler({
    read: () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    onStart: () => {
      starts++;
    },
    onResult: () => assert.fail("stale result"),
    onError: () => assert.fail("stale error"),
  });
  scheduler.request(false);
  scheduler.request(true);
  scheduler.dispose();
  finish(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  scheduler.request(false);
  assert.equal(starts, 1);
});
