import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId, SessionInfo } from "@lcode/contracts";
import {
  rankSessionHistorySearchCandidates,
  type SessionHistorySearchCandidate,
} from "./session-history-search.js";

const MIN_PRECISION_AT_THREE = 0.8;
const MAX_FALSE_POSITIVE_QUERY_RATE = 0.1;

const FIXTURE = [
  ["身份隔离", "sess_identity"],
  ["workspaceIdentity", "sess_identity"],
  ["command_inbox", "sess_commands"],
  ["CommandInbox", "sess_commands"],
  ["retry policy", "sess_retry"],
  ["dark theme", "sess_preferences"],
  ["内存预算", "sess_budget"],
  ["memory budget", "sess_budget"],
  ["zzzz-no-match", undefined],
  ["不存在的术语", undefined],
] as const;

test("SAR-10 multilingual offline fixture satisfies precision and false-positive gates", () => {
  const candidates = [
    candidate("sess_identity", "Workspace identity design", "远端身份隔离使用 workspaceIdentity"),
    candidate("sess_commands", "Command inbox admission", "CommandInbox serializes command_inbox"),
    candidate("sess_retry", "Provider retry policy", "retry policy preserves failover state"),
    candidate("sess_preferences", "User preferences", "The user prefers a dark theme"),
    candidate("sess_budget", "Memory budgets", "memory budget 与内存预算都必须有界"),
    candidate("sess_noise", "Unrelated rendering", "CSS layout and animation review"),
  ];
  let returnedCount = 0;
  let relevantReturnedCount = 0;
  let negativeQueryCount = 0;
  let falsePositiveQueryCount = 0;

  for (const [query, expectedSessionId] of FIXTURE) {
    const matches = rankSessionHistorySearchCandidates({ candidates, query }).slice(0, 3);
    if (expectedSessionId) {
      returnedCount += matches.length;
      relevantReturnedCount += matches.filter(
        (match) => match.session.id === expectedSessionId,
      ).length;
      assert.equal(matches[0]?.session.id, expectedSessionId, query);
    } else {
      negativeQueryCount += 1;
      if (matches.length > 0) falsePositiveQueryCount += 1;
    }
  }

  const precisionAtThree = relevantReturnedCount / Math.max(1, returnedCount);
  const falsePositiveQueryRate = falsePositiveQueryCount / Math.max(1, negativeQueryCount);
  assert.ok(precisionAtThree >= MIN_PRECISION_AT_THREE, String(precisionAtThree));
  assert.ok(
    falsePositiveQueryRate <= MAX_FALSE_POSITIVE_QUERY_RATE,
    String(falsePositiveQueryRate),
  );
});

function candidate(id: string, title: string, searchText: string): SessionHistorySearchCandidate {
  return {
    projection: {
      activeMessageCount: 1,
      projectedCharacterCount: searchText.length,
      searchText,
      truncated: false,
    },
    session: {
      id: id as SessionId,
      projectID: "project-fixture",
      taskType: "interactive",
      slug: id,
      directory: "/fixture",
      title,
      version: "1",
      time: { created: 1, updated: 1 },
    } as SessionInfo,
  };
}
