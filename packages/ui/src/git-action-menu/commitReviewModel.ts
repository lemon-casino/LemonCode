import type { GitCommitReview } from "@lcode/shared";
export function selectCommitReviewGroup(review: GitCommitReview | null, position: number) {
  return review?.groups[position] ?? null;
}
export function advanceCommitReviewPosition(
  review: GitCommitReview | null,
  position: number,
  committed: { id: string; groupId: string },
) {
  // 服务端同组重试返回相同成功事实，UI 也只能消费一次，避免重复响应跳过下一组。
  return review?.id === committed.id && review.groups[position]?.id === committed.groupId
    ? position + 1
    : position;
}
export function canSubmitCommitReview(
  review: GitCommitReview | null,
  position: number,
  acknowledged: boolean,
) {
  if (!review) return true;
  const group = selectCommitReviewGroup(review, position);
  return Boolean(group && (!group.requiresConfirmation || acknowledged));
}
