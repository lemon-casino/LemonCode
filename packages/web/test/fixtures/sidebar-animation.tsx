import { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { BorderBeam } from "border-beam";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { SidebarAnimationRows } from "./sidebar-animation-rows.js";
import "@/styles.css";

let commits = 0;
const trace: { phase: string; revision: number }[] = [];
function Fixture() {
  const [revision, setRevision] = useState(0);
  return (
    <main className="w-80 p-4">
      <button onClick={() => setRevision((value) => value + 1)} data-testid="refresh-row">
        更新侧栏行
      </button>
      <ScopedErrorBoundary scope="sidebar-animation-fixture">
        <Profiler
          id="beam"
          onRender={(_, phase) => {
            document.body.dataset.beamCommits = String(++commits);
            trace.push({ phase, revision });
            document.body.dataset.beamTrace = JSON.stringify(trace);
          }}
        >
          <BorderBeam size="line" active={false} borderRadius={8}>
            <div data-testid="workspace-row" className="rounded-lg p-2">
              工作区 {revision}
            </div>
          </BorderBeam>
        </Profiler>
      </ScopedErrorBoundary>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("rows") ? <SidebarAnimationRows /> : <Fixture />,
);
