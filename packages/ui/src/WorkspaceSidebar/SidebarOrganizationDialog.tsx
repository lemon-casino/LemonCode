import { useState } from "react";
import { Check, Cloud, Folder, GitBranch, Hash, MessageCircle, Plus, Search } from "lucide-react";
import { sidebarEntryKey, type SidebarEntryRef, type SidebarMutation } from "@lcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarOrganizationDialog({
  onTarget,
}: {
  onTarget(entry: SidebarEntryRef): void;
}) {
  const organization = useSidebarOrganization();
  const dialog = organization?.dialog;
  if (!dialog || !organization) return null;
  return (
    <OrganizationDialogContent
      key={`${dialog.type}:${dialog.sectionId ?? ""}`}
      onTarget={onTarget}
    />
  );
}
function OrganizationDialogContent({ onTarget }: { onTarget(entry: SidebarEntryRef): void }) {
  const organization = useSidebarOrganization()!;
  const dialog = organization.dialog!;
  const text = useSidebarText();
  const section = organization.snapshot.sections.find((item) => item.id === dialog.sectionId);
  const [title, setTitle] = useState(dialog.type === "rename" ? (section?.title ?? "") : "");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [entries, setEntries] = useState<SidebarEntryRef[]>(dialog.entries ?? []);
  const needsTitle = ["create", "rename", "split"].includes(dialog.type);
  const chooseEntries = ["add", "split", "target"].includes(dialog.type);
  const chooseSection = dialog.type === "move" || (dialog.type === "add" && !section);
  const allowed = new Set(section?.entries.map(sidebarEntryKey));
  const catalog = organization.catalog.filter(
    (item) =>
      (dialog.type !== "split" || allowed.has(sidebarEntryKey(item.ref))) &&
      (dialog.type !== "target" || item.ref.kind !== "task") &&
      (dialog.type !== "target" || !section || allowed.has(sidebarEntryKey(item.ref))) &&
      `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selected = new Set(entries.map(sidebarEntryKey));
  const toggle = (entry: SidebarEntryRef) =>
    setEntries((current) =>
      selected.has(sidebarEntryKey(entry))
        ? current.filter((item) => sidebarEntryKey(item) !== sidebarEntryKey(entry))
        : [...current, entry],
    );
  const canSubmit =
    organization.writable &&
    (!needsTitle || Boolean(title.trim())) &&
    (!chooseEntries || entries.length > 0) &&
    (!chooseSection || Boolean(target)) &&
    (dialog.type !== "target" ||
      dialog.purpose === "manage" ||
      entries.every(
        (entry) =>
          organization.catalog.find((item) => sidebarEntryKey(item.ref) === sidebarEntryKey(entry))
            ?.available !== false,
      ));
  const submit = async () => {
    if (!canSubmit) return;
    if (dialog.type === "target") {
      if (entries[0]) {
        organization.showDialog(null);
        onTarget(entries[0]);
      }
      return;
    }
    const normalized = entries;
    const mutations: SidebarMutation[] = [];
    if (dialog.type === "rename" && section)
      mutations.push({ type: "rename", sectionId: section.id, title: title.trim() });
    else if (dialog.type === "dissolve" && section)
      mutations.push({ type: "remove", sectionId: section.id });
    else if (dialog.type === "create" || dialog.type === "split") {
      const id = crypto.randomUUID();
      mutations.push({ type: "create", section: { id, title: title.trim(), entries: [] } });
      if (normalized.length) mutations.push({ type: "move", entries: normalized, sectionId: id });
    } else
      mutations.push({
        type: "move",
        entries: normalized,
        sectionId: section?.id ?? (target === "natural" ? null : target),
      });
    if (mutations.length && (await organization.run(mutations))) {
      organization.showDialog(null);
      organization.setBatch(false);
    }
  };
  const heading =
    dialog.type === "create"
      ? "newSection"
      : dialog.type === "target"
        ? dialog.purpose === "manage"
          ? "manage"
          : "chooseTarget"
        : dialog.type === "add"
          ? "chooseItems"
          : dialog.type === "move"
            ? "move"
            : dialog.type === "split"
              ? "split"
              : dialog.type === "dissolve"
                ? "dissolve"
                : "rename";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !organization.pending) organization.showDialog(null);
      }}
    >
      <DialogContent className="max-w-md gap-4" data-testid="sidebar-organization-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hash className="size-4 text-foreground-subtle" />
            {text(heading)}
          </DialogTitle>
          <DialogDescription>
            {text(dialog.type === "dissolve" ? "dissolveHint" : "placementHint")}
          </DialogDescription>
        </DialogHeader>
        {needsTitle ? (
          <label className="space-y-2 text-ui-sm">
            <span>{text("sectionName")}</span>
            <Input
              autoFocus
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && !chooseEntries)
                  void submit();
              }}
            />
          </label>
        ) : null}
        {chooseEntries || chooseSection ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-foreground-subtlest" />
            <Input
              className="pl-9"
              aria-label={text("search")}
              placeholder={text("search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
        <div
          className="max-h-72 space-y-1 overflow-y-auto"
          role={chooseSection ? "radiogroup" : undefined}
          aria-label={chooseSection ? text("move") : undefined}
        >
          {chooseSection ? (
            <>
              {organization.snapshot.sections
                .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    role="radio"
                    aria-checked={target === item.id}
                    onClick={() => setTarget(item.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-ui-base hover:bg-menu-hover focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  >
                    <Hash className="size-4 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="text-ui-sm text-foreground-subtlest">
                      {item.entries.length}
                    </span>
                    {target === item.id ? <Check className="size-4" /> : null}
                  </button>
                ))}
              {dialog.type === "move" ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={target === "natural"}
                  onClick={() => setTarget("natural")}
                  className="w-full rounded-lg px-3 py-2 text-left text-ui-base hover:bg-menu-hover"
                >
                  {text("natural")}
                  {target === "natural" ? <Check className="float-right size-4" /> : null}
                </button>
              ) : null}
            </>
          ) : null}
          {chooseEntries
            ? catalog.map((item) => {
                const Icon =
                  item.ref.kind === "project"
                    ? Folder
                    : item.ref.kind === "worktree"
                      ? GitBranch
                      : MessageCircle;
                return (
                  <button
                    type="button"
                    key={sidebarEntryKey(item.ref)}
                    role="checkbox"
                    disabled={
                      dialog.type === "target" &&
                      dialog.purpose !== "manage" &&
                      item.available === false
                    }
                    aria-checked={selected.has(sidebarEntryKey(item.ref))}
                    onClick={() => {
                      if (dialog.type === "target") setEntries([item.ref]);
                      else toggle(item.ref);
                    }}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-ui-base hover:bg-menu-hover focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-40"
                  >
                    <Icon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      <span className="block truncate text-ui-sm text-foreground-subtlest">
                        {item.detail}
                      </span>
                    </span>
                    {item.detail.includes(text("remoteProject")) ? (
                      <Cloud className="size-3" />
                    ) : null}
                    {selected.has(sidebarEntryKey(item.ref)) ? (
                      <Check className="size-4 shrink-0" />
                    ) : null}
                  </button>
                );
              })
            : null}
          {chooseEntries && !catalog.length ? (
            <p className="p-3 text-ui-sm text-foreground-subtle">{text("noItems")}</p>
          ) : null}
        </div>
        {dialog.type === "dissolve" && section ? (
          <div className="rounded-lg bg-surface px-3 py-2 text-ui-sm">
            {section.title} · {section.entries.length}
          </div>
        ) : null}
        {chooseSection ? (
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => organization.showDialog({ type: "create", entries })}
          >
            <Plus className="size-4" />
            {text("createMove")}
          </Button>
        ) : null}
        {chooseEntries ? (
          <p className="text-ui-sm text-foreground-subtle">
            {text("selected")} {entries.length} · {text("selectedHint")}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={organization.pending}
            onClick={() => organization.showDialog(null)}
          >
            {text("cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {text("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
