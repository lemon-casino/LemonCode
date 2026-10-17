import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  sidebarEntryKey,
  sidebarEntryRefSchema,
  sidebarOrganizationSchema,
  type SidebarEntryRef,
  type SidebarMutation,
  type SidebarOrganization,
} from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { createSidebarOrganizationStore } from "@/store/sidebarOrganizationStore.js";
import { invertSidebarMutations, normalizeSidebarSelection } from "@/lib/sidebarOrganization.js";
import { toast } from "@/components/ui/toast.js";
import { submitSidebarOrganization } from "./sidebarOrganizationCommands.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";

export interface SidebarCatalogItem {
  ref: SidebarEntryRef;
  label: string;
  detail: string;
  naturalParent?: SidebarEntryRef;
  available?: boolean;
}
export type SidebarOrganizationDialog = {
  type: "create" | "edit" | "rename" | "move" | "add" | "split" | "dissolve" | "target";
  purpose?: "manage" | "create";
  sectionId?: string;
  entries?: SidebarEntryRef[];
};
export interface SidebarProjectEditorTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: import("@lcode/shared").RemoteTarget;
  localProjectId?: string;
  label: string;
}
interface OrganizationContext {
  isDesktop: boolean;
  snapshot: SidebarOrganization;
  writable: boolean;
  pending: boolean;
  error: string | null;
  run(
    mutations: SidebarMutation[],
    undoable?: boolean,
    reconcile?: boolean,
    expectedRevision?: number,
  ): Promise<boolean>;
  undo(): void;
  canUndo: boolean;
  dialog: SidebarOrganizationDialog | null;
  showDialog(value: SidebarOrganizationDialog | null, expected?: SidebarOrganizationDialog): void;
  catalog: SidebarCatalogItem[];
  setCatalog(items: SidebarCatalogItem[]): void;
  sectionFor(entry: SidebarEntryRef): string | null;
  batch: boolean;
  setBatch(value: boolean): void;
  selected: SidebarEntryRef[];
  select(entry: SidebarEntryRef, extend?: boolean): void;
  target(entry: SidebarEntryRef): void;
  projectEditor: SidebarProjectEditorTarget | null;
  editProject(
    target: SidebarProjectEditorTarget | null,
    expected?: SidebarProjectEditorTarget,
  ): void;
  scopeTarget: Extract<SidebarEntryRef, { kind: "task" }> | null;
  inspectScope(target: Extract<SidebarEntryRef, { kind: "task" }> | null): void;
}
const Context = createContext<OrganizationContext | null>(null);
export const useSidebarOrganization = () => useContext(Context);

export function SidebarOrganizationProvider({
  children,
  isDesktop = false,
}: {
  children: ReactNode;
  isDesktop?: boolean;
}) {
  const service = useBaseWorkspaceServices().sidebarOrganizationService;
  const store = useMemo(createSidebarOrganizationStore, [service]);
  const state = useStore(store);
  const text = useSidebarText();
  const textRef = useRef(text);
  textRef.current = text;
  const [dialog, setDialog] = useState<SidebarOrganizationDialog | null>(null);
  const [projectEditor, setProjectEditor] = useState<SidebarProjectEditorTarget | null>(null);
  // 中文依据：已提交命令可以在关闭后完成；旧回调只能关闭它原先的视图，不能关闭用户后来打开的编辑器。
  const showDialog = useCallback(
    (value: SidebarOrganizationDialog | null, expected?: SidebarOrganizationDialog) =>
      setDialog((current) => (expected === undefined || current === expected ? value : current)),
    [],
  );
  const editProject = useCallback(
    (value: SidebarProjectEditorTarget | null, expected?: SidebarProjectEditorTarget) =>
      setProjectEditor((current) =>
        expected === undefined || current === expected ? value : current,
      ),
    [],
  );
  const [scopeTarget, inspectScope] = useState<Extract<SidebarEntryRef, { kind: "task" }> | null>(
    null,
  );
  const [catalog, setCatalog] = useState<SidebarCatalogItem[]>([]);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<SidebarEntryRef[]>([]);
  const selectionAnchor = useRef<SidebarEntryRef | null>(null);
  const [inverse, setInverse] = useState<{ revision: number; mutations: SidebarMutation[] } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    if (!service) {
      store.setState({ error: textRef.current("unavailable") });
      return;
    }
    const accept = (input: SidebarOrganization) => {
      if (!active) return;
      const parsed = sidebarOrganizationSchema.safeParse(input);
      if (parsed.success) store.getState().accept(parsed.data);
      else store.setState({ error: textRef.current("unavailable"), ready: false });
    };
    const subscription = service.onDidChange(accept);
    void service
      .getSnapshot()
      .then(accept)
      .catch(() => {
        if (active) store.setState({ error: textRef.current("unavailable"), ready: false });
      });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [service, store]);
  const run = useCallback(
    async (
      mutations: SidebarMutation[],
      undoable = true,
      reconcile = false,
      expectedRevision?: number,
    ) => {
      const current = store.getState();
      if (!service || !current.ready || current.pending || current.error) return false;
      store.setState({ pending: true });
      try {
        const parents = new Map(
          catalogRef.current
            .filter((item) => item.naturalParent)
            .map((item) => [sidebarEntryKey(item.ref), sidebarEntryKey(item.naturalParent!)]),
        );
        mutations = mutations.map((mutation) =>
          mutation.type === "move"
            ? {
                ...mutation,
                entries: normalizeSidebarSelection(
                  mutation.entries,
                  current.snapshot.sections.flatMap((section) => section.entries),
                  parents,
                ),
              }
            : mutation,
        );
        let result = await submitSidebarOrganization(service, {
          operationId: crypto.randomUUID(),
          expectedRevision: expectedRevision ?? current.snapshot.revision,
          mutations,
        });
        if (
          result.status === "conflict" &&
          reconcile &&
          mutations.every((mutation) => mutation.type === "import" || mutation.type === "forget")
        ) {
          // 只允许已确认删除的引用清理、一次性导入重放；用户移动和撤销仍严格拒绝冲突。
          result = await submitSidebarOrganization(service, {
            operationId: crypto.randomUUID(),
            expectedRevision: result.snapshot.revision,
            mutations,
          });
        }
        store.getState().accept(sidebarOrganizationSchema.parse(result.snapshot));
        if (result.status === "conflict") {
          toast(textRef.current("conflict"));
          setInverse(null);
          return false;
        }
        if (undoable)
          setInverse({
            revision: result.snapshot.revision,
            mutations: invertSidebarMutations(current.snapshot, mutations),
          });
        return true;
      } catch {
        try {
          store.getState().accept(sidebarOrganizationSchema.parse(await service.getSnapshot()));
        } catch {
          /* 保留最后一次确认的快照。 */
        }
        toast(textRef.current("failed"), { variant: "warning" });
        return false;
      } finally {
        store.setState({ pending: false });
      }
    },
    [service, store],
  );
  const value: OrganizationContext = {
    isDesktop,
    snapshot: state.snapshot,
    writable: state.ready && !state.pending && !state.error,
    pending: state.pending,
    error: state.error,
    run,
    dialog,
    projectEditor,
    editProject,
    scopeTarget,
    inspectScope,
    showDialog,
    catalog,
    setCatalog,
    batch,
    setBatch: (next) => {
      setBatch(next);
      if (!next) {
        setSelected([]);
        selectionAnchor.current = null;
      }
    },
    selected,
    select: (entry, extend) => {
      const visible = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="unified-sidebar-tree"] [data-sidebar-ref]',
        ),
      ]
        .filter((node) => node.getClientRects().length)
        .flatMap((node) => {
          try {
            return [sidebarEntryRefSchema.parse(JSON.parse(node.dataset.sidebarRef!))];
          } catch {
            return [];
          }
        });
      const anchorIndex = visible.findIndex(
        (item) =>
          selectionAnchor.current &&
          sidebarEntryKey(item) === sidebarEntryKey(selectionAnchor.current),
      );
      const index = visible.findIndex((item) => sidebarEntryKey(item) === sidebarEntryKey(entry));
      if (extend && anchorIndex >= 0 && index >= 0)
        setSelected((items) => [
          ...new Map(
            [
              ...items,
              ...visible.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1),
            ].map((item) => [sidebarEntryKey(item), item]),
          ).values(),
        ]);
      else {
        selectionAnchor.current = entry;
        setSelected((items) =>
          items.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry))
            ? items.filter((item) => sidebarEntryKey(item) !== sidebarEntryKey(entry))
            : [...items, entry],
        );
      }
    },
    target: (entry) => {
      if (batch)
        setSelected((items) =>
          items.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry)) ? items : [entry],
        );
    },
    sectionFor: (entry) =>
      state.snapshot.sections.find((section) =>
        section.entries.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry)),
      )?.id ?? null,
    canUndo: Boolean(inverse && inverse.revision === state.snapshot.revision),
    undo: () => {
      if (inverse && inverse.revision === store.getState().snapshot.revision) {
        void run(inverse.mutations, false).then((ok) => {
          if (ok) setInverse(null);
        });
      }
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
