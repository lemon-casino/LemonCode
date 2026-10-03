import { useCallback, useRef, useState } from "react";
import type { GitCommitReview } from "@lcode/shared";
import {
  canSubmitCommitReview,
  selectCommitReviewGroup,
  advanceCommitReviewPosition,
} from "@/git-action-menu/commitReviewModel.js";

export function useGitCommitReview(scope: string) {
  const [state, setState] = useState<{
    scope: string;
    review: GitCommitReview | null;
    error: string | null;
    position: number;
    acknowledged: boolean;
  } | null>(null);
  const target = useRef(scope);
  const epoch = useRef(0);
  if (target.current !== scope) epoch.current++;
  target.current = scope;
  const current = state?.scope === scope ? state : null;
  const clear = useCallback(() => {
    epoch.current++;
    setState(null);
  }, []);
  const begin = useCallback(() => ++epoch.current, []);
  const adopt = useCallback(
    (review: GitCommitReview | undefined, ticket?: number, error?: string) => {
      if (target.current !== scope || (ticket !== undefined && ticket !== epoch.current))
        return false;
      setState(
        review || error
          ? {
              scope,
              review: review ?? null,
              error: error ?? null,
              position: 0,
              acknowledged: false,
            }
          : null,
      );
      return true;
    },
    [scope],
  );
  const acknowledge = useCallback(
    (value: boolean) => setState((prior) => (prior ? { ...prior, acknowledged: value } : prior)),
    [],
  );
  const hydrate = useCallback(
    (review: GitCommitReview, position: number) => {
      epoch.current++;
      setState({ scope, review, error: null, position, acknowledged: false });
    },
    [scope],
  );
  const advance = useCallback(
    (id: string, groupId: string) =>
      setState((prior) => {
        if (!prior) return prior;
        const position = advanceCommitReviewPosition(prior.review, prior.position, { id, groupId });
        return position === prior.position ? prior : { ...prior, position, acknowledged: false };
      }),
    [],
  );
  return {
    review: current?.review ?? null,
    error: current?.error ?? null,
    position: current?.position ?? 0,
    acknowledged: current?.acknowledged ?? false,
    group: selectCommitReviewGroup(current?.review ?? null, current?.position ?? 0),
    canSubmit:
      !current?.error &&
      canSubmitCommitReview(
        current?.review ?? null,
        current?.position ?? 0,
        current?.acknowledged ?? false,
      ),
    clear,
    begin,
    adopt,
    hydrate,
    acknowledge,
    advance,
  };
}
