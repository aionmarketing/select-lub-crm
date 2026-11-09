/**
 * Test design (testing-strategy)
 *
 * Setup: `archiveVehicleReturn`, `unarchiveVehicleReturn` and
 * `createReturnReminder` from returnReminders.ts, driven against a stubbed
 * `globalThis.fetch` that records the RequestInit it was handed. Session from
 * useAuthSession (setupTests seeds a bearer).
 *
 * Oracle: found by the Follow-up exploratory tour on 2026-09-10
 * (`apps/e2e/test/tours/runs/2026-09-10-follow-up.md`, finding 1). The shared
 * `send` helper declared `content-type: application/json` on every write,
 * including the two that send no body. Fastify refuses that combination with
 * `FST_ERR_CTP_EMPTY_JSON_BODY` (400) before the route runs, so
 * `Arquivar este retorno` and its unarchive never worked. Proven live: the same
 * endpoint answers 200 when the header is absent. `cancelScheduledMessage` in
 * `./scheduled.ts` is the in-repo pattern this now matches.
 *
 * This is the durable pin. The tour that found it is quarantined from CI by
 * design, so without these cases a regression would ship unnoticed.
 *
 * Axes
 *   A1 body — absent (archive, unarchive) / present (createReturnReminder)
 *
 * Outputs
 *   O1 content-type header — omitted when there is no body, set when there is
 *   O2 request body — undefined when absent, JSON string when present
 *   O3 method and path
 *
 * Sampled-cell
 *   archive            | A1 absent  | O1,O2,O3 | JSON content-type on an empty body (the defect)
 *   unarchive          | A1 absent  | O1,O2,O3 | same defect on the sibling call
 *   create reminder    | A1 present | O1,O2    | header dropped for a real body
 *
 * Decision / branch map (returnReminders.ts `send`)
 *   const hasBody = body !== undefined
 *   headers: hasBody ? {...headers(), "content-type"} : headers()
 *                     T create-reminder it; F archive + unarchive its
 *   body: hasBody ? JSON.stringify(body) : undefined
 *                     T create-reminder it; F archive + unarchive its
 *
 * Out of scope: the refusal-body shape (`ReminderRefusal`), which the Follow-up
 * screen's own tests cover, and the API side of the contract, which is
 * `apps/api`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveVehicleReturn,
  createReturnReminder,
  unarchiveVehicleReturn,
} from "./returnReminders.js";

/** The last `fetch` call the helper made, as `[url, init]`. */
let lastCall: [string, RequestInit] | null = null;

/**
 * Reads the content-type off a recorded call, however the headers were built.
 * @param init - RequestInit the helper passed to `fetch`.
 * @returns The declared content-type, or `undefined` when none was set.
 */
function contentTypeOf(init: RequestInit) {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers["content-type"] ?? headers["Content-Type"];
}

beforeEach(() => {
  lastCall = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      lastCall = [url, init];
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("returnReminders write helper", () => {
  it("archives without declaring a JSON content-type on an empty body", async () => {
    await archiveVehicleReturn("ret-1");

    expect(lastCall).not.toBeNull();
    const [url, init] = lastCall!;
    expect(url).toContain("/vehicle-returns/ret-1/archive");
    expect(init.method).toBe("POST");
    // The defect: Fastify answers 400 FST_ERR_CTP_EMPTY_JSON_BODY when this
    // header is present with no body, so the button never archived anything.
    expect(contentTypeOf(init)).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("unarchives without declaring a JSON content-type on an empty body", async () => {
    await unarchiveVehicleReturn("ret-1");

    const [url, init] = lastCall!;
    expect(url).toContain("/vehicle-returns/ret-1/unarchive");
    expect(init.method).toBe("POST");
    expect(contentTypeOf(init)).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("still declares JSON and serialises the body when a write carries one", async () => {
    // The other side of the branch: dropping the header unconditionally would
    // break every write that does send a body, so this is what stops the fix
    // from over-reaching.
    await createReturnReminder("ret-1", {
      conversationId: "conv-1",
      triggers: [{ at: "2099-01-01T12:00:00.000Z" }],
    } as Parameters<typeof createReturnReminder>[1]).catch(() => undefined);

    const [, init] = lastCall!;
    expect(contentTypeOf(init)).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toMatchObject({ conversationId: "conv-1" });
  });
});
