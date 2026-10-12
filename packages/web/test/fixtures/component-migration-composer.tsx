import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { Button } from "@/components/ui/button.js";
import "@lcode/ui/styles.css";

// C06：自动化 Instructions 复合输入的迁移契约。value/onChange 草稿所有者在 fixture（与
// AutomationEditView 一致），onInput 次数与表单提交次数记录在 window.__composer。
const bridge = {
  inputs: [] as Array<{ value: string; isComposing: boolean }>,
  submits: 0,
};
Object.assign(window, { __composer: bridge });

function Fixture() {
  const [prompt, setPrompt] = useState("");
  return (
    <main className="min-h-dvh bg-background p-4 text-ui-base text-foreground">
      <div data-testid="fixture-ready" className="h-px w-px" />
      <form
        data-testid="composer-form"
        className="w-full max-w-xl"
        onSubmit={(event) => {
          event.preventDefault();
          bridge.submits += 1;
        }}
      >
        <AutomationInstructionsComposer>
          <AutomationInstructionsTextarea
            id="automation-prompt"
            aria-label="指令"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onInput={(event) => {
              bridge.inputs.push({
                value: event.currentTarget.value,
                isComposing: event.nativeEvent.isComposing,
              });
            }}
            placeholder="描述自动化要执行的指令"
          />
          <AutomationInstructionsToolbar>
            <Button type="submit">保存</Button>
          </AutomationInstructionsToolbar>
        </AutomationInstructionsComposer>
      </form>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
