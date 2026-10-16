import type { AuthWireProtocol } from "@lcode/provider-node";
/** 与真实 SDK parser 匹配的最小厂商 wire 响应，含真实归一 usage。 */
export function sdkResponse(protocol: AuthWireProtocol, stream: boolean): Response {
  const headers = {
    "content-type": stream ? "text/event-stream" : "application/json",
    "x-lcode-cache-ttl-ms": "1000",
    "x-lcode-cache-group": "verified-fixture",
    "x-lcode-cache-portability": "portable",
  };
  if (protocol === "openai-chat-completions")
    return new Response(
      stream
        ? 'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n'
        : JSON.stringify({
            id: "fixture",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      { headers },
    );
  if (protocol === "anthropic-messages") {
    const message = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      stream
        ? events.map((e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n").join("")
        : JSON.stringify({
            ...message,
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      { headers },
    );
  }
  const item = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "model",
    output: [item],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "ok",
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: "ok",
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(
    stream
      ? events
          .map(
            (e, sequence_number) =>
              "event: " + e.type + "\ndata: " + JSON.stringify({ ...e, sequence_number }) + "\n\n",
          )
          .join("")
      : JSON.stringify(response),
    { headers },
  );
}
