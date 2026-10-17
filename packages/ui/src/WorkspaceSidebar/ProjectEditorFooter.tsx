import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DialogFooter } from "@/components/ui/dialog.js";
import { useSidebarText } from "./sidebarText.js";

export function ProjectEditorFooter({
  canSave,
  saving,
  onCancel,
  onSave,
}: {
  canSave: boolean;
  saving: boolean;
  onCancel(): void;
  onSave(): void;
}) {
  const text = useSidebarText();
  return (
    <DialogFooter data-testid="project-editor-footer">
      <Button variant="outline" onClick={onCancel}>
        {text("cancel")}
      </Button>
      <Button disabled={!canSave} onClick={onSave}>
        {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {text("saveChanges")}
      </Button>
    </DialogFooter>
  );
}
