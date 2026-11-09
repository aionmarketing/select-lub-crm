/**
 * Test support: fake OpenAI Responses API streams (switch-oil-research-to-openai task 1.3), so the
 * OpenAI research path is driven through the real SDK, the real watchdog and the real search
 * adapter with no socket. Nothing in production imports it. `fakeTransport` records each
 * request's URL and parsed body and answers with what a test returns for it.
 *
 * A stream is a script of server-sent events, each emitted `afterMs` after the one before (on the
 * timers, so `vi.useFakeTimers()` drives it). A script that does not end with `end` leaves the
 * stream open: a call that went silent. The Responses API sends no `[DONE]`; the stream closes.
 *
 * Fixture values are chosen far from any wrong default (memory: "fixture must sit far from the
 * wrong answer"): liters 3,3 where the wrong engine column gives 4,0.
 */

/** One request the fake received: the URL and its parsed JSON body. */
export type CapturedRequest = { url: string; body: Record<string, unknown> };

/**
 * A fake transport: records every request's URL and parsed body, and answers with what `respond`
 * returns for it.
 *
 * @param respond - The response for one request, by its index and its body.
 */
export function fakeTransport(respond: (request: CapturedRequest, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const request = { url, body: JSON.parse(raw) as Record<string, unknown> };
    requests.push(request);
    if (init?.signal?.aborted) throw init.signal.reason;
    return respond(request, requests.length - 1);
  };
  return { fetch: fakeFetch, requests };
}

/** The text of one Responses `input` item's content: a string, or the `text` of each part. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/** The text of the request's `role` items (`input`), joined; empty when there is none. */
function inputText(request: CapturedRequest, roles: readonly string[]): string {
  const input = Array.isArray(request.body.input) ? (request.body.input as Array<{ role?: string; content?: unknown }>) : [];
  return input.filter((item) => item.role !== undefined && roles.includes(item.role)).map((item) => textOfContent(item.content)).join("\n");
}

/** The user prompt a Responses request carried. */
export function userPromptOf(request: CapturedRequest): string {
  return inputText(request, ["user"]);
}

/** The system prompt a Responses request carried (`instructions`, or a system/developer item). */
export function systemPromptOf(request: CapturedRequest): string {
  const instructions = typeof request.body.instructions === "string" ? request.body.instructions : "";
  return [instructions, inputText(request, ["system", "developer"])].filter((text) => text !== "").join("\n");
}

/** A reasoning-summary delta `afterMs` after the step before it: a call that is reasoning, alive. */
export function reasoningStep(afterMs = 0): ResponsesStep {
  return { afterMs, event: reasoningEvents()[2]! };
}

/** One step of a Responses stream. */
export type ResponsesStep = { afterMs?: number; event: Record<string, unknown> } | { afterMs?: number; end: true };

/** Encodes a script as a `text/event-stream` response, the way the Responses API frames events. */
export function responsesStream(steps: readonly ResponsesStep[], status = 200): Response {
  const encoder = new TextEncoder();
  let timers: ReturnType<typeof setTimeout>[] = [];
  let sequence = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      for (const step of steps) {
        at += step.afterMs ?? 0;
        timers.push(
          setTimeout(() => {
            try {
              if ("end" in step) {
                controller.close();
              } else {
                const event: Record<string, unknown> = { sequence_number: sequence++, ...step.event };
                controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
              }
            } catch {
              // The consumer cancelled the stream (an abort); nothing more to send.
            }
          }, at),
        );
      }
    },
    cancel() {
      timers.forEach(clearTimeout);
      timers = [];
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** A usage block as the Responses API reports it. */
export type FakeUsage = { input: number; output: number; cached?: number; cacheWrite?: number; reasoning?: number };

/** The wire form of {@link FakeUsage}. */
export function wireUsage(usage: FakeUsage): Record<string, unknown> {
  return {
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: usage.cached ?? 0, ...(usage.cacheWrite ? { cache_write_tokens: usage.cacheWrite } : {}) },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    total_tokens: usage.input + usage.output,
  };
}

/** `response.created`. */
export function createdEvent(model = "gpt-6.1-sol"): Record<string, unknown> {
  return { type: "response.created", response: { id: "resp_fake", created_at: 0, model, status: "in_progress" } };
}

/** A reasoning item opening, and one reasoning-summary delta: what a reasoning call streams. */
export function reasoningEvents(text = "Lendo o trecho…"): Record<string, unknown>[] {
  return [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_fake", summary: [] } },
    { type: "response.reasoning_summary_part.added", item_id: "rs_fake", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_fake", output_index: 0, summary_index: 0, delta: text },
  ];
}

/** A message item carrying `text`, in one delta. */
export function messageEvents(text: string, outputIndex = 1): Record<string, unknown>[] {
  return [
    { type: "response.output_item.added", output_index: outputIndex, item: { type: "message", id: "msg_fake", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_fake", output_index: outputIndex, content_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: { type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
    },
  ];
}

/** `response.completed` with a usage block. */
export function completedEvent(usage: FakeUsage, model = "gpt-6.1-sol"): Record<string, unknown> {
  return { type: "response.completed", response: { id: "resp_fake", created_at: 0, model, status: "completed", incomplete_details: null, usage: wireUsage(usage) } };
}

/** `response.incomplete`: the output limit was reached, possibly before any answer. */
export function incompleteEvent(usage: FakeUsage, reason = "max_output_tokens"): Record<string, unknown> {
  return { type: "response.incomplete", response: { id: "resp_fake", created_at: 0, model: "gpt-6.1-sol", status: "incomplete", incomplete_details: { reason }, usage: wireUsage(usage) } };
}

/** A whole answer: created, reasoning, the text, completed with `usage`, and the stream closed. */
export function answerScript(text: string, usage: FakeUsage = { input: 1_200, output: 300, reasoning: 200 }): ResponsesStep[] {
  return [
    { event: createdEvent() },
    ...reasoningEvents().map((event) => ({ event })),
    ...messageEvents(text).map((event) => ({ event })),
    { event: completedEvent(usage) },
    { end: true },
  ];
}

/** A web search action as a `web_search_call` item reports it. */
export type FakeAction =
  | { type: "search"; queries?: string[]; sources?: string[] }
  | { type: "open_page"; url: string }
  | { type: "find_in_page"; url: string; pattern?: string };

/** The wire form of an action. */
function wireAction(action: FakeAction): Record<string, unknown> {
  if (action.type === "search") {
    return { type: "search", queries: action.queries ?? ["consulta"], sources: (action.sources ?? []).map((url) => ({ type: "url", url })) };
  }
  return { ...action };
}

/** A finished `web_search_call` item, as `response.output_item.done` carries it. */
export function webSearchCallEvents(id: string, action: FakeAction, outputIndex: number, status = "completed"): Record<string, unknown>[] {
  return [
    { type: "response.output_item.added", output_index: outputIndex, item: { type: "web_search_call", id, status: "in_progress" } },
    { type: "response.web_search_call.searching", item_id: id, output_index: outputIndex },
    { type: "response.output_item.done", output_index: outputIndex, item: { type: "web_search_call", id, status, action: wireAction(action) } },
  ];
}

/**
 * A whole search response: one `web_search_call` per action, a reply text (which the adapter must
 * discard), and completed with `usage`.
 */
export function searchScript(actions: readonly FakeAction[], reply = "Encontrei o manual.", usage: FakeUsage = { input: 9_000, output: 1_200, reasoning: 800 }): ResponsesStep[] {
  return [
    { event: createdEvent() },
    ...actions.flatMap((action, i) => webSearchCallEvents(`ws_${i}`, action, i).map((event) => ({ event }))),
    ...messageEvents(reply, actions.length).map((event) => ({ event })),
    { event: completedEvent(usage) },
    { end: true },
  ];
}

/** An error answer with `status` and an optional `Retry-After`. */
export function errorResponse(status: number, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { message: `fake ${status}`, type: "fake", code: String(status) } }), {
    status,
    headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
  });
}
