/**
 * Reading an OpenAI Responses API stream (switch-oil-research-to-openai D3): the events, the
 * usage split the meter prices, and what a search response's `web_search_call` items yield.
 * Split out of `openai-search.ts`, which makes the calls; nothing here opens a socket.
 */
import type { TokenUsage } from "./search-cost.js";
import { pageKey } from "./search-hits.js";

/** One event of a Responses stream. */
type StreamEvent = { type?: string; [key: string]: unknown };

/** What a streamed Responses call gave. */
export type ResponsesReply = {
  /** The concatenated output text. */
  text: string;
  /** `output_item.done` items, in order. */
  items: Record<string, unknown>[];
  /** `completed`, `incomplete`, `failed`, or `null` when the stream ended without saying. */
  status: "completed" | "incomplete" | "failed" | null;
  usage: TokenUsage | null;
  /** The model the response names. */
  model: string | null;
};

/** The meter's split, from a Responses usage block. */
export function usageOfResponses(raw: unknown): TokenUsage | null {
  if (raw == null || typeof raw !== "object") return null;
  const usage = raw as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  if (usage.input_tokens == null && usage.output_tokens == null) return null;
  const cachedInput = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    input: Math.max(0, (usage.input_tokens ?? 0) - cachedInput - cacheWrite),
    cachedInput,
    reasoning,
    output: Math.max(0, (usage.output_tokens ?? 0) - reasoning),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

/** A reply with nothing read yet. */
export function emptyReply(): ResponsesReply {
  return { text: "", items: [], status: null, usage: null, model: null };
}

/**
 * Reads a Responses server-sent-event stream. Every network chunk calls `onChunk` (the watchdog's
 * bump), so a stream that keeps sending events is alive however long it reasons.
 *
 * @param reply - Filled as the events arrive, so a caller still sees what arrived (the search
 *   items it must pay for) when the stream errors, is aborted, or ends without a status.
 */
export async function readResponsesStream(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  signal: AbortSignal,
  reply: ResponsesReply = emptyReply(),
): Promise<ResponsesReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      onChunk();
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data === "" || data === "[DONE]") continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(data) as StreamEvent;
        } catch {
          continue;
        }
        const response = (event.response ?? null) as { usage?: unknown; model?: string } | null;
        switch (event.type) {
          case "response.created":
            reply.model = response?.model ?? null;
            break;
          case "response.output_text.delta":
            if (typeof event.delta === "string") reply.text += event.delta;
            break;
          case "response.output_item.done":
            if (event.item && typeof event.item === "object") reply.items.push(event.item as Record<string, unknown>);
            break;
          case "response.completed":
          case "response.incomplete":
          case "response.failed":
            reply.status = event.type === "response.completed" ? "completed" : event.type === "response.incomplete" ? "incomplete" : "failed";
            reply.usage = usageOfResponses(response?.usage);
            if (response?.model) reply.model = response.model;
            break;
          case "error":
            reply.status = "failed";
            break;
          default:
            break;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return reply;
}

/** The candidates a search response's `web_search_call` items yield. */
export type SearchActions = {
  /** Consulted sources and opened pages, deduplicated, in the order the response gave them. */
  urls: string[];
  searchActions: number;
  pageActions: number;
  /** A `web_search_call` the provider reports as failed. */
  failed: boolean;
};

/**
 * Reads the `web_search_call` items: each search action's sources, each page opened (`open_page`);
 * a `find_in_page` is counted as a page action and adds no URL, since it searches a page already
 * opened. The reply text is never read here.
 */
export function readSearchActions(items: readonly Record<string, unknown>[]): SearchActions {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: unknown) => {
    if (typeof url !== "string" || url.trim() === "") return;
    const key = pageKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(url.trim());
  };
  let searchActions = 0;
  let pageActions = 0;
  let failed = false;
  for (const item of items) {
    if (item.type !== "web_search_call") continue;
    if (item.status === "failed" || item.status === "incomplete") failed = true;
    const action = (item.action ?? {}) as { type?: string; url?: unknown; sources?: unknown };
    if (action.type === "open_page" || action.type === "find_in_page") {
      pageActions += 1;
      if (action.type === "open_page") add(action.url);
      continue;
    }
    searchActions += 1;
    if (Array.isArray(action.sources)) {
      for (const source of action.sources) {
        if (source && typeof source === "object" && (source as { type?: string }).type !== "api") add((source as { url?: unknown }).url);
      }
    }
  }
  return { urls, searchActions, pageActions, failed };
}

/** The titles the reply's `url_citation` annotations give, by page; the reply's URLs are not candidates. */
export function citationTitles(items: readonly Record<string, unknown>[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ annotations?: unknown }>) {
      if (!Array.isArray(part.annotations)) continue;
      for (const raw of part.annotations as Array<{ type?: string; url?: string; title?: string }>) {
        if (raw.type === "url_citation" && raw.url && raw.title) titles.set(pageKey(raw.url), raw.title);
      }
    }
  }
  return titles;
}
