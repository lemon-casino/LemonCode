import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, File, FolderOpen, FolderSearch, Loader2, RefreshCw } from "lucide-react";
import type {
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { selectTriggerVariants } from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

/** 已保存项可能已从探测结果中消失，仍需与探测结果一起展示。 */
type ShellEntry = Pick<IntegratedTerminalShellOption, "dialect" | "id" | "label" | "path">;

/** 含路径分隔符的输入按 Host 路径解析，而不是按名称过滤已探测 Shell。 */
function isPathQuery(value: string): boolean {
  return /[\\/]/.test(value);
}

function matchesQuery(values: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value.toLowerCase().includes(needle));
}

function selectionFor(entry: ShellEntry): IntegratedTerminalShellSelection {
  return { mode: "shell", ...entry };
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
  const shells: ShellEntry[] = selected
    ? [selected, ...options.filter((option) => option.id !== selected.id)]
    : options;
  const pathQuery = isPathQuery(query);
  const visibleShells = shells.filter((entry) => matchesQuery([entry.label, entry.path], query));
  // “自动选择”与 Shell 选项同受过滤词约束，避免过滤后仍残留一条无关选项。
  const showAuto = matchesQuery([message("auto")], query);
  // 目录候选是上一次路径解析的结果，必须等用户明确选择。
  const showCandidates = candidates.length > 1;

  function closePanel() {
    setOpen(false);
    setQuery("");
    setCandidates([]);
    setError(null);
  }

  async function save(value: IntegratedTerminalShellSelection) {
    try {
      await onChange(value);
      if (active.current) closePanel();
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
    if (resolved.length === 0) {
      setCandidates([]);
      setError("invalidPath");
    } else if (resolved.length === 1) {
      await save(selectionFor(resolved[0]!));
    } else {
      // 候选必须等用户明确选择。同时清空过滤词：目录路径不是候选路径的前缀时，
      // 残留的过滤词会把候选整组过滤掉。
      setQuery("");
      setCandidates(resolved);
    }
  }

  async function browse(picker: () => Promise<string | null>) {
    const value = await picker();
    if (value && active.current) await resolvePath(value);
  }

  function renderShellItems(items: ShellEntry[], checked?: ShellEntry) {
    return items.map((entry) => (
      <CommandItem
        key={entry.id}
        value={entry.id}
        data-checked={checked?.id === entry.id ? "true" : undefined}
        disabled={busy}
        onSelect={() => void run(() => save(selectionFor(entry)))}
      >
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate">{entry.label}</span>
          <span className="truncate font-mono text-ui-xs text-foreground-subtle">{entry.path}</span>
        </span>
      </CommandItem>
    ));
  }

  function renderAction(label: string, icon: ReactNode, disabled: boolean, onClick: () => void) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        // 菜单内操作行沿用菜单 hover，避免与面板选项的选中态用两套高亮。
        className="h-auto min-h-8 w-full min-w-0 justify-start gap-2 whitespace-normal px-2 py-1.5 text-left hover:bg-menu-hover"
        onClick={onClick}
      >
        {icon}
        {label}
      </Button>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else closePanel();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          aria-busy={busy}
          aria-label={intl.formatMessage({ id: "settings.integratedTerminalShell" })}
          // 触发器与同页 Select/Input 使用同一套输入外壳：outline 变体自带 hover 底色，
          // 这里显式压回输入背景，保持与 Select trigger 的 hover 表现一致。
          className={cn(
            selectTriggerVariants({ variant: "input", size: "lg" }),
            "w-full min-w-0 overflow-hidden hover:bg-input aria-expanded:bg-input",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0">{selected?.label ?? message("auto")}</span>
            {selected ? (
              <span className="min-w-0 flex-1 truncate text-left font-mono text-ui-xs text-foreground-subtle">
                {selected.path}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon className="size-4 text-foreground-subtle" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-(--radix-popover-content-available-height) w-(--radix-popover-trigger-width) min-w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-lg bg-menu p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // 触控端不自动唤起软键盘，避免遮挡候选列表。
          if (isCoarseTouchDevice()) return;
          const content = event.currentTarget;
          if (!(content instanceof HTMLElement)) return;
          content.querySelector<HTMLElement>('[data-slot="command-input"]')?.focus();
        }}
      >
        {/*
          关闭 cmdk 内置模糊匹配，改用下面的确定性过滤：它的评分对含空格和中文的
          绝对路径会返回 0，导致“应用路径”项被判定为不匹配而隐藏。
        */}
        <Command shouldFilter={false} className="h-auto min-h-0 bg-transparent p-0 text-foreground">
          <CommandInput
            value={query}
            disabled={busy}
            placeholder={message("searchPlaceholder")}
            onValueChange={(value) => {
              setQuery(value);
              setCandidates([]);
              setError(null);
            }}
            onKeyDown={(event) => {
              // 路径输入必须确定地作用于该路径，不能被同屏的已探测 Shell 抢走回车。
              if (event.key !== "Enter" || !pathQuery) return;
              event.preventDefault();
              void run(() => resolvePath(query));
            }}
          />
          <CommandList className="min-h-0 max-h-64">
            {showCandidates ? (
              <CommandGroup heading={message("directoryShells")} className="p-1">
                {renderShellItems(candidates)}
              </CommandGroup>
            ) : pathQuery ? (
              <CommandGroup className="p-1">
                <CommandItem
                  value={query.trim()}
                  disabled={busy}
                  onSelect={() => void run(() => resolvePath(query))}
                >
                  <FolderSearch className="size-4 shrink-0 text-foreground-subtle" />
                  <span className="shrink-0">{message("applyPath")}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle">
                    {query.trim()}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                <CommandGroup className="p-1">
                  {showAuto ? (
                    <CommandItem
                      value="auto"
                      data-checked={selected ? undefined : "true"}
                      disabled={busy}
                      onSelect={() => void run(() => save({ mode: "auto" }))}
                    >
                      {message("auto")}
                    </CommandItem>
                  ) : null}
                  {renderShellItems(visibleShells, selected)}
                </CommandGroup>
                {!showAuto && visibleShells.length === 0 ? (
                  <p className="px-3 py-5 text-center text-ui-base text-foreground-subtle">
                    {message("empty")}
                  </p>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
        {error ? (
          <p
            role="alert"
            className="shrink-0 border-t border-border px-3 py-2 text-ui-sm break-all text-destructive"
          >
            {message(error)}
          </p>
        ) : null}
        {/* 底部操作放在 cmdk 根节点之外：进入命令区会让回车同时触发选项和按钮。 */}
        <div className="shrink-0 border-t border-border p-1">
          {onSelectDirectory
            ? renderAction(
                message("selectDirectory"),
                <FolderOpen />,
                busy,
                () => void run(() => browse(onSelectDirectory)),
              )
            : null}
          {onSelectFile
            ? renderAction(
                message("selectFile"),
                <File />,
                busy,
                () => void run(() => browse(onSelectFile)),
              )
            : null}
          {renderAction(
            message("refresh"),
            loading ? <Loader2 className="animate-spin" /> : <RefreshCw />,
            busy || loading,
            () => void run(onRefresh),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
