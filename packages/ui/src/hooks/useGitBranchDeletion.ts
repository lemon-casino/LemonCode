import { useEffect, useRef, useState } from "react";
import type { GitLocalBranch } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export function useGitBranchDeletion({
  workspacePath,
  workspaceIdentity,
  branch,
  onDeleted,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  branch: GitLocalBranch | null;
  onDeleted: (name: string) => void;
}) {
  const { gitService } = useServices();
  const { intl } = useLCodeIntl();
  const key = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    branch?.name,
    branch?.commitHash,
  ]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const [state, setState] = useState<{ key: string; pending: boolean; error?: string }>({
    key,
    pending: false,
  });
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async () => {
    if (!branch?.commitHash || branch.isCurrent || branch.checkedOutPath || inFlight.current)
      return;
    const submittedKey = key;
    inFlight.current = true;
    setState({ key, pending: true });
    try {
      const result = await gitService.deleteBranch({
        workspacePath,
        workspaceIdentity,
        branchName: branch.name,
        expectedCommitHash: branch.commitHash,
      });
      // 确认框切项目或卸载后，旧删除结果不能关闭另一个项目的确认框。
      if (!mounted.current || keyRef.current !== submittedKey) return;
      if (!result.ok)
        setState({
          key,
          pending: false,
          error: intl.formatMessage({ id: `git.branchDelete.error.${result.code}` }),
        });
      else {
        setState({ key, pending: false });
        onDeleted(branch.name);
      }
    } catch (error) {
      if (mounted.current && keyRef.current === submittedKey)
        setState({ key, pending: false, error: getErrorMessage(error) });
    } finally {
      inFlight.current = false;
    }
  };
  return {
    pending: state.key === key && state.pending,
    error: state.key === key ? state.error : undefined,
    submit,
  };
}
