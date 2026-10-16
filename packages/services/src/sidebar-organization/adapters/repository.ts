import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import { z } from "zod";
import {
  emptySidebarOrganization,
  sidebarOrganizationSchema,
  type SidebarOrganization,
  type SidebarOrganizationRequest,
} from "@lcode/shared";
import { assertUniquePlacements, applySidebarMutations } from "../domain/transition.js";

const fileSchema = z.strictObject({
  snapshot: sidebarOrganizationSchema,
  operations: z.record(
    z.string(),
    z.strictObject({ fingerprint: z.string(), revision: z.number().int() }),
  ),
});
export function createOrganizationRepository(path: string) {
  async function read() {
    try {
      const result = fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
      assertUniquePlacements(result.snapshot);
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          snapshot: emptySidebarOrganization(),
          operations: {} as Record<string, { fingerprint: string; revision: number }>,
        };
      throw error;
    }
  }
  return {
    async getSnapshot(): Promise<SidebarOrganization> {
      return (await read()).snapshot;
    },
    async apply(request: SidebarOrganizationRequest) {
      return withFileLock(`${path}.lock`, async () => {
        const file = await read();
        const fingerprint = JSON.stringify(request);
        const previous = file.operations[request.operationId];
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new Error("Sidebar operationId reused with different input");
          return { status: "applied" as const, snapshot: file.snapshot };
        }
        if (file.snapshot.revision !== request.expectedRevision)
          return { status: "conflict" as const, snapshot: file.snapshot };
        const snapshot = applySidebarMutations(file.snapshot, request.mutations);
        file.operations[request.operationId] = { fingerprint, revision: snapshot.revision };
        await atomicWritePrivateTextFile(
          path,
          JSON.stringify({ snapshot, operations: file.operations }),
        );
        return { status: "applied" as const, snapshot };
      });
    },
  };
}
