/**
 * The app's ticking clock (background-oil-research D14, D17).
 *
 * `useNow` re-renders its caller on an interval with the browser's current time. `useServerNow`
 * turns that into the SERVER's current time, from the `now` a response carried and the instant
 * the browser received it: the offset between the two clocks is computed once per response, so a
 * skewed browser clock neither resets nor distorts a counter anchored on a server instant, and a
 * remount that reads the same cached response keeps counting from the same anchor.
 */
import { useEffect, useState } from "react";

/**
 * The browser's current time, re-read every `intervalMs` while `enabled`.
 *
 * @param intervalMs - How often the caller re-renders; 1 000 for a seconds counter.
 * @param enabled - False stops the interval, for a caller that shows no counter.
 * @returns Milliseconds since the epoch, on the browser's clock.
 */
export function useNow(intervalMs = 1_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    // Re-read at once, so a caller that re-enables the clock does not show a stale instant.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * How far the server's clock is ahead of the browser's, from one response.
 *
 * @param serverNow - The response's `now`, an ISO instant on the server's clock.
 * @param receivedAt - When the browser received that response, on its own clock (TanStack
 * Query's `dataUpdatedAt`).
 * @returns Milliseconds to add to a browser instant to get the server's; 0 for an unreadable
 * `serverNow`, so a malformed value degrades to the browser's clock rather than to NaN.
 */
export function serverClockOffsetMs(serverNow: string, receivedAt: number): number {
  const server = Date.parse(serverNow);
  return Number.isNaN(server) ? 0 : server - receivedAt;
}

/**
 * The server's current time, ticking every `intervalMs`.
 *
 * @param serverNow - The latest response's `now`, or null when nothing is timed (the clock stops).
 * @param receivedAt - When that response arrived, on the browser's clock.
 * @param intervalMs - Tick interval.
 * @returns Milliseconds since the epoch on the server's clock.
 */
export function useServerNow(serverNow: string | null, receivedAt: number, intervalMs = 1_000): number {
  const now = useNow(intervalMs, serverNow != null);
  return serverNow == null ? now : now + serverClockOffsetMs(serverNow, receivedAt);
}
