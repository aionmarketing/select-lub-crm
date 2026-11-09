/**
 * The three bounds a streamed call runs under (background-oil-research D2): silence
 * (`idle`), a ceiling in minutes (`ceiling`), and an outer signal — a web search's budget, later
 * the research run's (`budget`). Whichever fires first aborts the call and names itself.
 *
 * The idle timer is reset from the TRANSPORT, by every network chunk of the response body, not
 * by the SDK's stream parts: `@ai-sdk/openai` holds every part back until the first content
 * delta arrives (`throwIfOpenAIStreamErrorBeforeOutput`), and this model reasons for up to a
 * minute before that, so a timer fed by parts would fire on a call that is reasoning steadily.
 */

/** Why a call was aborted. */
export type TimeoutKind = "idle" | "ceiling" | "budget";

/** A running watchdog. */
export type CallWatchdog = {
  /** Aborted when any bound fires; hand it to the call. */
  signal: AbortSignal;
  /** Resets the idle timer: something arrived. */
  bump(): void;
  /** Which bound fired, or `null`. */
  fired(): TimeoutKind | null;
  /** Clears the timers; call when the call settles. */
  dispose(): void;
};

/**
 * Starts the bounds. The idle timer starts now: waiting for the first byte counts as silence.
 *
 * @param bounds.idleMs - Silence that aborts the call; `Infinity` for no idle timer (a provider
 *   that does not stream its reasoning).
 * @param bounds.ceilingMs - The call's ceiling.
 * @param bounds.outer - An outer signal; its abort is `budget`.
 */
export function startWatchdog(bounds: { idleMs: number; ceilingMs: number; outer?: AbortSignal }): CallWatchdog {
  const controller = new AbortController();
  let kind: TimeoutKind | null = null;
  const abort = (why: TimeoutKind) => {
    if (controller.signal.aborted) return;
    kind = why;
    controller.abort(new DOMException(`model call aborted: ${why}`, "TimeoutError"));
  };
  // setTimeout(fn, Infinity) fires at once: an unbounded idle time must set no timer at all.
  const idleTimer = () => (Number.isFinite(bounds.idleMs) ? setTimeout(() => abort("idle"), bounds.idleMs) : undefined);
  let idle = idleTimer();
  const ceiling = setTimeout(() => abort("ceiling"), bounds.ceilingMs);
  const onOuter = () => abort("budget");
  if (bounds.outer?.aborted) onOuter();
  else bounds.outer?.addEventListener("abort", onOuter, { once: true });

  return {
    signal: controller.signal,
    bump() {
      if (controller.signal.aborted) return;
      clearTimeout(idle);
      idle = idleTimer();
    },
    fired: () => kind,
    dispose() {
      clearTimeout(idle);
      clearTimeout(ceiling);
      bounds.outer?.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * Wraps a response so every body chunk calls `onChunk`, and the body errors as soon as
 * `signal` aborts — a transport that ignores the signal still cannot hold the call open.
 */
export function tapResponse(res: Response, onChunk: () => void, signal: AbortSignal): Response {
  if (!res.body) return res;
  let onAbort: (() => void) | null = null;
  const tapped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        onAbort = () => controller.error(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      transform(chunk, controller) {
        onChunk();
        controller.enqueue(chunk);
      },
      flush() {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      },
    }),
  );
  return new Response(tapped, { status: res.status, statusText: res.statusText, headers: res.headers });
}
