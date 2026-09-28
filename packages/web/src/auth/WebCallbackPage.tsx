import { useEffect, useState } from "react";
import { Button } from "@lcode/ui";
import type { WebAuthCallbackResult, WebAuthService } from "./webAuthService.js";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebCallbackPageProps {
  authService: Pick<WebAuthService, "handleCallback">;
  onSuccess: (result: WebAuthCallbackResult) => void;
  onRetry: () => void;
}

export function WebCallbackPage({ authService, onRetry, onSuccess }: WebCallbackPageProps) {
  const copy = getWebAuthCopy();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    authService
      .handleCallback(window.location.href)
      .then((result) => {
        if (!isMounted || !result) {
          return;
        }
        onSuccess(result);
      })
      .catch((caught) => {
        if (!isMounted) {
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      });

    return () => {
      isMounted = false;
    };
  }, [authService, onSuccess]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        {error ? (
          <>
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-destructive text-ui-xs font-medium text-destructive-foreground">
              !
            </div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.callbackErrorTitle}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {copy.callbackErrorDescription}
            </p>
            <p className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs leading-5 text-foreground-subtle">
              {error}
            </p>
            <Button type="button" size="lg" className="mt-5 w-full" onClick={onRetry}>
              {copy.retryAction}
            </Button>
          </>
        ) : (
          <>
            <div className="mb-4 size-9 rounded-full border-2 border-border border-t-primary" />
            <h1 className="text-ui-lg font-medium text-foreground">{copy.callbackTitle}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {copy.callbackDescription}
            </p>
          </>
        )}
      </section>
    </main>
  );
}
