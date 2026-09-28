/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/file-tree-basic.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by LCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";

const Example = () => (
  <FileTree>
    <FileTreeFolder name="src" path="src">
      <FileTreeFile name="index.ts" path="src/index.ts" />
    </FileTreeFolder>
    <FileTreeFile name="package.json" path="package.json" />
  </FileTree>
);

export default Example;
