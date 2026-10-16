import type { ReactNode } from "react";
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useSidebarText } from "./sidebarText.js";
export function ProjectRemoteSyncGroup({
  children,
  dropdown,
  disabled,
}: {
  children: ReactNode;
  dropdown: boolean;
  disabled: boolean;
}) {
  const text = useSidebarText();
  const Sub = dropdown ? DropdownMenuSub : ContextMenuSub;
  const Trigger = dropdown ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
  const Content = dropdown ? DropdownMenuSubContent : ContextMenuSubContent;
  return (
    <Sub>
      <Trigger disabled={disabled} title={disabled ? text("offline") : undefined}>
        {text("syncRemote")}
      </Trigger>
      <Content>{children}</Content>
    </Sub>
  );
}
