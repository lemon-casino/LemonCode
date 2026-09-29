import assert from "node:assert/strict";
import test from "node:test";
import { ALERT_DIALOG_LAYERS } from "./alert-dialog.js";

test("确认弹窗位于自己的遮罩之上，且整体盖住父级交互浮层", () => {
  assert.deepEqual(ALERT_DIALOG_LAYERS, {
    parentInteractiveOverlay: 60,
    backdrop: { zIndex: 70, className: "z-[70]" },
    content: { zIndex: 71, className: "z-[71]" },
  });
  assert.ok(ALERT_DIALOG_LAYERS.backdrop.zIndex > ALERT_DIALOG_LAYERS.parentInteractiveOverlay);
  assert.ok(ALERT_DIALOG_LAYERS.content.zIndex > ALERT_DIALOG_LAYERS.backdrop.zIndex);
});
