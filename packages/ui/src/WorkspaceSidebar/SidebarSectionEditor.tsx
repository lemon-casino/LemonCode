import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  GitBranch,
  Hash,
  Layers,
  MessageCircle,
  Plus,
  X,
} from "lucide-react";
import { sidebarEntryKey, type SidebarEntryRef, type SidebarSection } from "@lcode/shared";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarSectionEditor() {
  const organization = useSidebarOrganization()!;
  const text = useSidebarText();
  const sectionId = organization.dialog!.sectionId!;
  const current = organization.snapshot.sections.find((item) => item.id === sectionId);
  const [base, setBase] = useState(() => ({
    revision: organization.snapshot.revision,
    section: current,
  }));
  const [draft, setDraft] = useState<SidebarSection>(() => structuredClone(current!));
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState("");
  const [latestReviewed, setLatestReviewed] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(base.section);
  const conflict = base.revision !== organization.snapshot.revision;
  const close = () => {
    if (changed && !organization.pending) setDiscard(true);
    else organization.showDialog(null);
  };
  const keyOf = sidebarEntryKey;
  const selected = new Set(draft.entries.map(keyOf));
  const describe = (ref: SidebarEntryRef) =>
    organization.catalog.find((item) => keyOf(item.ref) === keyOf(ref));
  const setEntries = (entries: SidebarEntryRef[]) =>
    setDraft((value) => ({
      ...value,
      entries,
      defaultTargetRef:
        value.defaultTargetRef &&
        entries.some((entry) => keyOf(entry) === keyOf(value.defaultTargetRef!))
          ? value.defaultTargetRef
          : undefined,
    }));
  const reorder = (index: number, delta: number) => {
    const entries = [...draft.entries];
    const [entry] = entries.splice(index, 1);
    entries.splice(index + delta, 0, entry!);
    setEntries(entries);
  };
  const submit = async () => {
    setError("");
    const ok = await organization.run(
      [
        {
          type: "editSection",
          sectionId,
          title: draft.title.trim(),
          entries: draft.entries,
          ...(draft.defaultTargetRef ? { defaultTargetRef: draft.defaultTargetRef } : {}),
        },
      ],
      true,
      false,
      base.revision,
    );
    if (ok) organization.showDialog(null, organization.dialog!);
    else {
      setError(text("editConflict"));
      setLatestReviewed(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-w-xl flex-col gap-5 p-6 max-sm:inset-0 max-sm:max-h-dvh max-sm:max-w-full max-sm:translate-0 max-sm:rounded-none"
        data-testid="sidebar-section-editor"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-ui-lg font-semibold">
            <Hash className="size-5" />
            {text("editSection")}
          </DialogTitle>
          <DialogDescription>{text("placementHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <label className="block space-y-2 text-ui-sm">
            <span>{text("sectionName")}</span>
            <Input
              autoFocus
              maxLength={80}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-ui-sm">
              <span>
                {text("selected")} · {draft.entries.length}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setAdding(!adding)}>
                <Plus className="size-4" />
                {text("add")}
              </Button>
            </div>
            <div className="divide-y divide-border rounded-xl border border-border">
              {draft.entries.map((entry, index) => {
                const item = describe(entry);
                const Icon =
                  entry.kind === "project"
                    ? Folder
                    : entry.kind === "executionSet"
                      ? Layers
                      : entry.kind === "worktree"
                        ? GitBranch
                        : MessageCircle;
                return (
                  <div key={keyOf(entry)} className="flex items-center gap-2 px-3 py-3">
                    <Icon className="size-4 shrink-0 text-foreground-subtle" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui-base">{item?.label ?? keyOf(entry)}</div>
                      <div className="truncate text-ui-sm text-foreground-subtle">
                        {item?.detail ?? text("offline")}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${item?.label} · ${text("up")}`}
                      disabled={!index}
                      onClick={() => reorder(index, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${item?.label} · ${text("down")}`}
                      disabled={index === draft.entries.length - 1}
                      onClick={() => reorder(index, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${item?.label} · ${text("remove")}`}
                      onClick={() => setEntries(draft.entries.filter((_, i) => i !== index))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                );
              })}
              {!draft.entries.length ? (
                <p className="p-4 text-ui-sm text-foreground-subtle">{text("noItems")}</p>
              ) : null}
            </div>
          </div>
          {adding ? (
            <div className="space-y-2 rounded-xl bg-surface p-3">
              <Input
                aria-label={text("search")}
                placeholder={text("search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {organization.catalog
                  .filter(
                    (item) =>
                      !selected.has(keyOf(item.ref)) &&
                      `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((item) => {
                    const from = organization.snapshot.sections.find((section) =>
                      section.entries.some((entry) => keyOf(entry) === keyOf(item.ref)),
                    );
                    return (
                      <Button
                        key={keyOf(item.ref)}
                        variant="ghost"
                        className="h-auto w-full justify-start py-2 text-left"
                        onClick={() => setEntries([...draft.entries, item.ref])}
                      >
                        <Plus className="size-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate">{item.label}</span>
                          <span className="block truncate text-ui-sm text-foreground-subtle">
                            {item.detail}
                            {from ? ` · ${text("move")} ${from.title}` : ""}
                          </span>
                        </span>
                      </Button>
                    );
                  })}
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <span id="section-default-label" className="text-ui-sm">
              {text("defaultTarget")}
            </span>
            <Select
              value={draft.defaultTargetRef ? keyOf(draft.defaultTargetRef) : "choose"}
              onValueChange={(key) =>
                setDraft({
                  ...draft,
                  defaultTargetRef: draft.entries.find((entry) => keyOf(entry) === key),
                })
              }
            >
              <SelectTrigger className="w-full" aria-labelledby="section-default-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="choose">{text("everyTime")}</SelectItem>
                {draft.entries
                  .filter((entry) => entry.kind !== "task")
                  .map((entry) => (
                    <SelectItem key={keyOf(entry)} value={keyOf(entry)}>
                      {describe(entry)?.label ?? keyOf(entry)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {error || conflict || !current ? (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-border bg-surface p-3 text-ui-sm"
            >
              <p>{!current ? text("noItems") : error || text("editConflict")}</p>
              {current && conflict ? (
                <>
                  <p>
                    {current.title} · {current.entries.length}
                  </p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto">
                    {current.entries.map((entry) => (
                      <li key={keyOf(entry)} className="truncate" title={describe(entry)?.detail}>
                        {describe(entry)?.label ?? keyOf(entry)}
                        {current.defaultTargetRef &&
                        keyOf(current.defaultTargetRef) === keyOf(entry)
                          ? ` · ${text("defaultTarget")}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setBase({ revision: organization.snapshot.revision, section: current });
                      setLatestReviewed(true);
                      setError("");
                    }}
                  >
                    {text("reviewLatest")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {discard ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3"
            >
              <span className="mr-auto text-ui-sm">{text("unsaved")}</span>
              <Button variant="ghost" onClick={() => setDiscard(false)}>
                {text("keepEditing")}
              </Button>
              <Button variant="destructive" onClick={() => organization.showDialog(null)}>
                {text("discard")}
              </Button>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {text("cancel")}
          </Button>
          <Button
            disabled={
              !current ||
              !changed ||
              !draft.title.trim() ||
              organization.pending ||
              (conflict && !latestReviewed)
            }
            onClick={() => void submit()}
          >
            {text("saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
