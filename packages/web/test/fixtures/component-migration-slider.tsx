import { useState } from "react";
import { createRoot } from "react-dom/client";
// 迁移目标契约：Slider 适配器落在 packages/ui/src/components/controls/
// （packages/ui/src/components/ui/README.md 禁止改动三方基元目录）。
import { Slider } from "@/components/controls/Slider.js";
import "@lcode/ui/styles.css";

// C05：白板画笔粗细滑杆的迁移契约。WhiteboardPane.tsx 的 strokeWidth state 是唯一所有者
// （初值 5），适配层只做受控展示与连续 onChange，不新增第二份状态。
const bridge = { changes: [] as number[] };
Object.assign(window, { __slider: bridge });

function Fixture() {
  const [strokeWidth, setStrokeWidth] = useState(5);
  return (
    <main className="min-h-dvh bg-background p-4 text-ui-base text-foreground">
      <div data-testid="fixture-ready" className="h-px w-px" />
      <div data-testid="slider-surface" className="w-60 py-8">
        <Slider
          value={strokeWidth}
          onChange={(value) => {
            bridge.changes.push(value);
            setStrokeWidth(value);
          }}
          min={2}
          max={18}
          step={1}
          aria-label="笔触粗细"
        />
      </div>
      <output data-testid="stroke-width">{strokeWidth}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
