import { useCallback, useEffect, useRef, useState } from "react";
import type { IntegratedTerminalShellOption } from "@zcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";

export function useIntegratedTerminalShellOptions() {
  const { systemService } = useBaseWorkspaceServices();
  const [options, setOptions] = useState<IntegratedTerminalShellOption[]>([]);
  const [platform, setPlatform] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [loading, setLoading] = useState(false);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setLoading(true);
    try {
      const [info, shells] = await Promise.all([
        systemService.info(),
        systemService.listIntegratedTerminalShells(),
      ]);
      if (request !== latestRequest.current) return;
      setHomeDir(info.homedir);
      setPlatform(info.platform);
      setOptions(shells);
    } catch {
      if (request === latestRequest.current) setOptions([]);
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [systemService]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);

  return { options, platform, homeDir, loading, refresh };
}
