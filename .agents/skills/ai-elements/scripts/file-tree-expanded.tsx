/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/file-tree-expanded.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by LCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";

const Example = () => (
  <FileTree defaultExpanded={new Set(["src", "src/components"])}>
    <FileTreeFolder name="src" path="src">
      <FileTreeFolder name="components" path="src/components">
        <FileTreeFile name="button.tsx" path="src/components/button.tsx" />
        <FileTreeFile name="input.tsx" path="src/components/input.tsx" />
      </FileTreeFolder>
      <FileTreeFile name="index.ts" path="src/index.ts" />
    </FileTreeFolder>
  </FileTree>
);

export default Example;
