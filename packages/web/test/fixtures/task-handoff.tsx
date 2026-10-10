import { useEffect, useState } from "react";
import { useGitFailureDraftReceiver } from "@/hooks/useGitFailureHandoff.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";

export function TaskHandoffFixture() {
  const [draft, setDraft] = useState("preserved draft");
  const [target, setTarget] = useState("handoff-target");
  const [identity, setIdentity] = useState<string>();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    useLCodeSessionStore.getState().setActiveTaskId("/fixture/repo", target);
  }, [target]);
  useGitFailureDraftReceiver(
    "/fixture/repo",
    identity,
    target,
    (text) => setDraft((previous) => `${previous}\n${text}`),
    enabled,
  );
  Object.assign(window, { __taskHandoffFixture: { setTarget, setIdentity, setEnabled } });
  return (
    <textarea
      data-testid="handoff-draft"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className="w-full text-mobile-input-safe"
    />
  );
}
