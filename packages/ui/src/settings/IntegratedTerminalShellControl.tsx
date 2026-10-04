import { useEffect, useRef, useState } from "react";
import { File, FolderOpen, RefreshCw } from "lucide-react";
import type {
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

function selectionFor(option: IntegratedTerminalShellOption): IntegratedTerminalShellSelection {
  return {
    mode: "shell",
    dialect: option.dialect,
    id: option.id,
    label: option.label,
    path: option.path,
  };
}

export function IntegratedTerminalShellControl({
  selection,
  options,
  loading,
  onRefresh,
  onChange,
  onResolvePath,
  onSelectFile,
  onSelectDirectory,
}: {
  selection: IntegratedTerminalShellSelection;
  options: IntegratedTerminalShellOption[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onChange: (selection: IntegratedTerminalShellSelection) => Promise<void>;
  onResolvePath: (path: string) => Promise<IntegratedTerminalShellOption[]>;
  onSelectFile?: () => Promise<string | null>;
  onSelectDirectory?: () => Promise<string | null>;
}) {
  const { intl } = useLCodeIntl();
  const message = (id: string) =>
    intl.formatMessage({ id: `settings.integratedTerminalShell.${id}` });
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<IntegratedTerminalShellOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const selected = selection.mode === "shell" ? selection : undefined;
  const visibleOptions = selected
    ? [selected, ...options.filter((option) => option.id !== selected.id)]
    : options;

  async function save(value: IntegratedTerminalShellSelection) {
    try {
      await onChange(value);
      if (active.current) {
        setCandidates([]);
        setPath("");
      }
    } catch {
      if (active.current) setError("saveFailed");
    }
  }

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch {
      if (active.current) setError("probeFailed");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function resolvePath(value: string) {
    const resolved = await onResolvePath(value.trim());
    if (!active.current) return;
    setPath(value);
    setCandidates([]);
    if (resolved.length === 0) setError("invalidPath");
    else if (resolved.length === 1) await save(selectionFor(resolved[0]!));
    else setCandidates(resolved);
  }

  async function browse(picker: () => Promise<string | null>) {
    const value = await picker();
    if (value && active.current) await resolvePath(value);
  }

  function renderOptions(
    items: Array<Pick<IntegratedTerminalShellOption, "id" | "label" | "path">>,
  ) {
    return items.map((option) => (
      <SelectItem key={option.id} value={option.id} textValue={option.label}>
        <span className="flex min-w-0 flex-col">
          <span>{option.label}</span>
          <span className="break-all text-ui-xs font-mono text-foreground-subtle">
            {option.path}
          </span>
        </span>
      </SelectItem>
    ));
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2" aria-busy={busy}>
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={selected?.id ?? "auto"}
          disabled={busy}
          onValueChange={(value) => {
            void run(async () => {
              if (value === "auto") await save({ mode: "auto" });
              else {
                const option = visibleOptions.find((item) => item.id === value);
                if (option) await save({ ...option, mode: "shell" });
              }
            });
          }}
        >
          <SelectTrigger
            size="lg"
            className="min-w-0 flex-1 justify-between"
            aria-label={intl.formatMessage({ id: "settings.integratedTerminalShell" })}
          >
            <SelectValue>{selected?.label ?? message("auto")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{message("auto")}</SelectItem>
            {renderOptions(visibleOptions)}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={busy || loading}
          aria-label={message("refresh")}
          title={message("refresh")}
          onClick={() => void run(onRefresh)}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>
      {selected ? (
        <p className="break-all text-ui-xs font-mono text-foreground-subtle">{selected.path}</p>
      ) : null}
      <div className="flex min-w-0 gap-2">
        <Input
          value={path}
          disabled={busy}
          aria-label={message("pathLabel")}
          placeholder={message("pathPlaceholder")}
          className="min-w-0 flex-1 font-mono text-mobile-input-safe md:text-ui-base"
          onChange={(event) => {
            setPath(event.currentTarget.value);
            setCandidates([]);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && path.trim()) {
              event.preventDefault();
              void run(() => resolvePath(path));
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !path.trim()}
          onClick={() => void run(() => resolvePath(path))}
        >
          {message("applyPath")}
        </Button>
      </div>
      {onSelectFile || onSelectDirectory ? (
        <div className="flex flex-wrap gap-2">
          {onSelectDirectory ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => browse(onSelectDirectory))}
            >
              <FolderOpen />
              {message("selectDirectory")}
            </Button>
          ) : null}
          {onSelectFile ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => browse(onSelectFile))}
            >
              <File />
              {message("selectFile")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {candidates.length > 1 ? (
        <div className="min-w-0 space-y-2">
          <p className="text-ui-caption text-foreground-subtle">{message("chooseCandidate")}</p>
          <Select
            value=""
            disabled={busy}
            onValueChange={(value) => {
              const option = candidates.find((item) => item.id === value);
              if (option) void run(() => save(selectionFor(option)));
            }}
          >
            <SelectTrigger className="w-full min-w-0" aria-label={message("directoryShells")}>
              <SelectValue placeholder={message("directoryShells")} />
            </SelectTrigger>
            <SelectContent>{renderOptions(candidates)}</SelectContent>
          </Select>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-caption text-destructive">
          {message(error)}
        </p>
      ) : null}
    </div>
  );
}
