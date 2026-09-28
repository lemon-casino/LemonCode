import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowStrategy,
} from "@lcode/contracts";

export const BUILT_IN_EXPERT_WORKFLOW_KIND = "expert";
export const BUILT_IN_EXPERT_WORKFLOW_DEFINITION_ID = "expert";
export const BUILT_IN_EXPERT_WORKFLOW_DEFINITION_VERSION = "2";

export const DEFAULT_EXPERT_WORKFLOW_STRATEGY: WorkflowStrategy = {
  clarify: {
    confidenceThreshold: 0.8,
    maxRounds: 3,
    minRounds: 1,
  },
  executor: {
    drainingChangeHours: 1,
    frontierTarget: 3,
    maxConcurrentLoops: 2,
    maxConsecutiveErrors: 3,
    maxPlannerRuns: 10,
  },
  finalCritic: {
    maxIterations: 3,
  },
  reactLoop: {
    maxRounds: 30,
  },
};

export function createExpertWorkflowDefinition(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    definitionId: BUILT_IN_EXPERT_WORKFLOW_DEFINITION_ID,
    definitionVersion: BUILT_IN_EXPERT_WORKFLOW_DEFINITION_VERSION,
    description:
      "Durable long-task workflow for large NL->Code work. Child agent sessions perform each phase.",
    kind: BUILT_IN_EXPERT_WORKFLOW_KIND,
    phaseOrder: [
      "clarify",
      "task_analysis",
      "arch_decompose",
      "env_setup",
      "meta_prompt",
      "exec",
      "final_critic",
      "complete",
    ],
    phases: [
      {
        artifactPath: "artifacts/01-clarify.md",
        behavior: "agent",
        description:
          "Refine the user goal, assumptions, acceptance criteria, and unresolved questions. Ask only if blocking.",
        phase: "clarify",
        title: "Clarify",
      },
      {
        artifactPath: "artifacts/02-task-analysis.md",
        behavior: "agent",
        description:
          "Map the task to repo context, constraints, risks, likely files, validation, and failure paths.",
        phase: "task_analysis",
        title: "Task Analysis",
      },
      {
        artifactPath: "artifacts/03-architecture-decompose.md",
        behavior: "agent",
        description:
          "Decompose the work into a dependency graph of implementation and verification nodes.",
        phase: "arch_decompose",
        seedGraphFromArtifact: {
          gateAfterPhase: "meta_prompt",
          targetPhase: "exec",
        },
        title: "Architecture Decompose",
      },
      {
        artifactPath: "artifacts/04-env-setup.md",
        behavior: "agent",
        description:
          "Check whether environment setup, dependencies, credentials, or local services are required.",
        phase: "env_setup",
        title: "Environment Setup",
      },
      {
        artifactPath: "artifacts/05-meta-prompt.md",
        behavior: "agent",
        description:
          "Create the execution instructions, constraints, and node prompts needed for downstream work.",
        nodePromptsFromArtifact: {
          targetPhase: "exec",
        },
        phase: "meta_prompt",
        title: "Meta Prompt",
      },
      {
        artifactPath: "artifacts/06-exec.md",
        behavior: "scheduled_graph",
        description:
          "Execute the planned work through the normal agent runtime. Preserve small steps and validation.",
        phase: "exec",
        title: "Execute",
      },
      {
        artifactPath: "artifacts/07-final-critic.md",
        behavior: "critic",
        description:
          "Review results against acceptance criteria, identify regressions, missing tests, and residual risk.",
        phase: "final_critic",
        title: "Final Critic",
      },
      {
        behavior: "complete",
        description: "Write final report and mark the run completed.",
        phase: "complete",
        title: "Complete",
      },
    ],
    strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
    title: "Expert Workflow",
  });
}

export function workflowDefinitionPhaseMap(
  definition: WorkflowDefinition,
): Map<string, WorkflowDefinition["phases"][number]> {
  return new Map(definition.phases.map((phase) => [phase.phase, phase]));
}
