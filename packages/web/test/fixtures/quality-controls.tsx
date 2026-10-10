import { useState } from "react";
import type { LCodeSavedWorkflowEntry } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Switch } from "@/components/ui/switch.js";
import { Badge } from "@/components/ui/badge.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select.js";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu.js";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog.js";
import { ToastMessageView } from "@/components/ui/toast.js";
import { OnboardingThemeSelector } from "@/onboarding/OnboardingThemeSelector.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import { useLCodeStore } from "@/store/StoreProvider.js";

const longLabel =
  "一个很长的中文与 English 选项名称 / https://example.invalid/very-long-path/for-quality";
const entry: LCodeSavedWorkflowEntry = {
  name: "Quality workflow",
  scope: "project",
  path: "/fixture/.lcode/workflows/quality.md",
  description: "Long production workflow form",
  args: Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [
      `field_${i}`,
      { type: "string" as const, default: `value_${i}`, description: longLabel },
    ]),
  ),
};

export function QualityControls({ english }: { english: boolean }) {
  const theme = useLCodeStore((state) => state.theme);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const [selected, setSelected] = useState("0");
  const [checked, setChecked] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(true);
  return (
    <main className="h-full overflow-auto bg-background p-4 text-ui-base text-foreground">
      <section className="mx-auto max-w-2xl space-y-4">
        <OnboardingThemeSelector theme={theme} saving={false} onSelect={setTheme} />
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="single-line">{english ? "Normal action" : "普通操作"}</Button>
          <Button disabled aria-busy="true">
            {english ? "Loading" : "加载中"}
          </Button>
          <Badge data-testid="quality-badge" variant="secondary">
            {english ? "Selected" : "已选中"}
          </Badge>
          <label className="flex items-center gap-2">
            <Checkbox
              aria-label="Quality checkbox"
              checked={checked}
              onCheckedChange={(v) => setChecked(v === true)}
            />
            Checkbox
          </label>
          <Checkbox aria-label="Mixed checkbox" checked="indeterminate" />
          <Switch aria-label="Quality switch" checked={switched} onCheckedChange={setSwitched} />
          <Switch aria-label="Disabled switch" disabled />
        </div>
        <label className="block">
          Number
          <Input aria-label="Quality number" type="number" defaultValue="3" />
        </label>
        <Input aria-label="Readonly input" readOnly value="Readonly" />
        <Input aria-label="Disabled input" disabled value="Disabled" />
        <Input aria-label="Invalid input" aria-invalid="true" defaultValue="Invalid" />
        <InputGroup data-testid="quality-input-group">
          <InputGroupAddon>@</InputGroupAddon>
          <InputGroupInput aria-label="Group input" placeholder="Input group" />
        </InputGroup>
        <div className="flex gap-4">
          <label>
            <input type="radio" name="quality-radio" defaultChecked /> A
          </label>
          <label>
            <input type="radio" name="quality-radio" /> B
          </label>
        </div>
        <Tabs defaultValue="first">
          <TabsList>
            <TabsTrigger value="first">{english ? "First tab" : "首个标签"}</TabsTrigger>
            <TabsTrigger value="second">{english ? "Second tab" : "第二标签"}</TabsTrigger>
          </TabsList>
          <TabsContent value="first">First</TabsContent>
          <TabsContent value="second">Second</TabsContent>
        </Tabs>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-full" aria-label="Quality select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position={
              new URLSearchParams(location.search).get("select-position") === "item-aligned"
                ? "item-aligned"
                : "popper"
            }
          >
            {Array.from({ length: 40 }, (_, i) => (
              <SelectItem key={i} value={String(i)}>
                {longLabel} {i}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Popover>
          <PopoverTrigger asChild>
            <Button>Quality popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            {Array.from({ length: 30 }, (_, i) => (
              <p key={i}>
                {longLabel} {i}
              </p>
            ))}
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Quality dropdown</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {Array.from({ length: 40 }, (_, i) => (
              <DropdownMenuItem key={i}>
                {longLabel} {i}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ContextMenu>
          <ContextMenuTrigger>
            <div data-testid="quality-context-trigger" className="border border-border p-4">
              Context menu
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {Array.from({ length: 40 }, (_, i) => (
              <ContextMenuItem key={i}>
                {longLabel} {i}
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
        <Dialog>
          <DialogTrigger asChild>
            <Button>Long dialog</Button>
          </DialogTrigger>
          <DialogContent className="flex flex-col" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Long dialog title</DialogTitle>
            </DialogHeader>
            <DialogBody data-testid="long-dialog-body" className="space-y-3">
              {Array.from({ length: 30 }, (_, i) => (
                <Input key={i} aria-label={`Long input ${i}`} defaultValue={longLabel} />
              ))}
            </DialogBody>
            <DialogFooter>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Nested dialog</Button>
                </DialogTrigger>
                <DialogContent aria-describedby={undefined}>
                  <DialogTitle>Nested title</DialogTitle>
                  <Input aria-label="Nested input" />
                </DialogContent>
              </Dialog>
              <DialogClose asChild>
                <Button>Finish dialog</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button onClick={() => setWorkflowOpen(true)}>Production workflow</Button>
        <SavedWorkflowLaunchDialog
          entry={workflowOpen ? entry : null}
          scope="project"
          projectLabel="Quality project"
          onOpenChange={setWorkflowOpen}
          onSubmit={() => setWorkflowOpen(false)}
        />
        {toastOpen ? (
          <div data-testid="quality-toast">
            <ToastMessageView
              item={{
                id: 1,
                durationMs: 0,
                position: "top-right",
                variant: "info",
                message: `${longLabel}\n${longLabel}`,
                dismissible: true,
                dismissLabel: "Dismiss notice",
              }}
              visible
              onDismiss={() => setToastOpen(false)}
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}
