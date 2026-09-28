import type {
  GitCheckpointDiff,
  GitCheckpointDiffQuery,
  GitCheckpointMeta,
  GitCheckpointRequest,
  GitCheckpointRestoreQuery,
  GitCheckpointRestoreResult,
  GitRepositoryRequest,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IGitCheckpointService {
  createCheckpoint(params: GitRepositoryRequest): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: GitCheckpointDiffQuery): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: GitCheckpointRestoreQuery): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: GitCheckpointRequest): Promise<void>;
}

export const IGitCheckpointService = createServiceDescriptor<IGitCheckpointService>(
  ServiceChannels.GitCheckpoint,
);
