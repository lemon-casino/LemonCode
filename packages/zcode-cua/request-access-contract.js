// request_access 状态元数据的开源实现：对官方状态形状做严格结构校验。
// 官方链路里该形状由 Helper 签发（darwin TCC 判定），本仓库不签发、只提供消费方
// （UI/宿主读取 _meta[CUA_REQUEST_ACCESS_STATUS_META_KEY]）所需的严格解析。
export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";

const ACCESSIBILITY_STATES = new Set(["granted", "stale", "denied"]);
const SCREEN_RECORDING_STATES = new Set(["unknown", "granted", "denied"]);

function fail(message) {
  return { success: false, error: new Error(message) };
}

export const cuaRequestAccessStatusSchema = {
  safeParse(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail("Computer Use request-access status must be a plain object.");
    }
    if (input.schemaVersion !== 1) {
      return fail("Computer Use request-access status schemaVersion must be 1.");
    }
    // 官方语义：request_access 状态只由 darwin Helper 签发（TCC 判定在 Helper broker）。
    if (input.platform !== "darwin") {
      return fail('Computer Use request-access status platform must be "darwin".');
    }
    if (typeof input.grantOwner !== "string" || input.grantOwner.length === 0) {
      return fail("Computer Use request-access status grantOwner must be a non-empty string.");
    }
    if (typeof input.accessibility !== "string" || !ACCESSIBILITY_STATES.has(input.accessibility)) {
      return fail(
        "Computer Use request-access status accessibility must be granted, stale or denied.",
      );
    }
    if (
      typeof input.screenRecording !== "string" ||
      !SCREEN_RECORDING_STATES.has(input.screenRecording)
    ) {
      return fail(
        "Computer Use request-access status screenRecording must be unknown, granted or denied.",
      );
    }
    return {
      success: true,
      data: {
        schemaVersion: 1,
        platform: "darwin",
        grantOwner: input.grantOwner,
        accessibility: input.accessibility,
        screenRecording: input.screenRecording,
      },
    };
  },
};
