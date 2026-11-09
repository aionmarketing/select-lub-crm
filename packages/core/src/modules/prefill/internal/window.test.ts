/**
 * Test design (testing-strategy)
 *
 * Setup: closedWindowForConversation. No store, no OpenAI.
 *
 * Oracle: should-reply-window assistive-prefill delta — 60s silence closes
 * with one window covering both inbounds; outbound closes early; new inbound
 * restarts; watermark skips a closed window. Age is measured on
 * providerTimestamp (design D1).
 *
 * Axes
 *   A1 age vs 60_000 ms — 59_999 / 60_000 / 60_001
 *   A2 later outbound — absent / present after / present before
 *   A3 second inbound at 20s / 50s
 *   A4 watermark — null / equal to latest / 1ms before latest
 *   A5 inbound kind — text / empty body / image
 *
 * Outputs: O1 closed window with both ids; O2 null; O3 one id (restarted)
 *
 * Sampled-cell
 *   two inbounds + 60s              | A3 20s A1 60k | O1 both | null / one id
 *   59_999 ms                       | A1 −1         | O2      | closed
 *   60_000 ms                       | A1 edge       | O1      | null
 *   outbound at 30s                 | A2 after      | O2      | closed
 *   inbound at 50s, now 50s         | A3 50s        | O2      | closed
 *   watermark = latest              | A4 equal      | O2      | closed again
 *   watermark 1ms before            | A4 −1         | O1      | null
 *   empty-body inbound              | A5 empty      | O2      | treated as text
 *   image inbound only              | A5 image      | O2      | closed
 *   outbound before two inbounds    | A2 before     | O1 last two | include pre-outbound
 *
 * Decision map
 *   D1 no inbound text              T: image/empty its; F: silence its
 *   D2 later outbound               T: outbound-30s it; F: silence its
 *   D3 age < 60s                    T: 59999 / 50s its; F: 60000 / 60001
 *   D4 watermark >= latest          T: equal it; F: null / 1ms before
 *   D5 last outbound before latest  T: outbound-before it; F: no outbound
 *
 * Out of scope: job enqueue (enqueue.test.ts); LLM (extract.test.ts);
 * history stamp (history.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  closedWindowForConversation,
  PREFILL_WINDOW_MS,
  type WindowMessage,
} from "./window.js";

const t0 = new Date("2026-08-31T12:00:00.000Z");

function at(offsetMs: number) {
  return new Date(t0.getTime() + offsetMs);
}

function inbound(id: string, offsetMs: number, text = "oi"): WindowMessage {
  return {
    id,
    direction: "inbound",
    messageType: "text",
    textBody: text,
    providerTimestamp: at(offsetMs),
  };
}

function outbound(id: string, offsetMs: number): WindowMessage {
  return {
    id,
    direction: "outbound",
    messageType: "text",
    textBody: "ok",
    providerTimestamp: at(offsetMs),
  };
}

describe("closedWindowForConversation", () => {
  it("closes after 60s of silence covering both inbounds 20s apart", () => {
    const closed = closedWindowForConversation(
      "conv-1",
      [inbound("a", 0), inbound("b", 20_000)],
      null,
      at(20_000 + PREFILL_WINDOW_MS),
    );

    expect(closed).toEqual({
      conversationId: "conv-1",
      inboundIds: ["a", "b"],
      latestInboundAt: at(20_000),
    });
  });

  it("stays open at 59_999 ms after the latest inbound", () => {
    expect(
      closedWindowForConversation("conv-1", [inbound("a", 0)], null, at(PREFILL_WINDOW_MS - 1)),
    ).toBeNull();
  });

  it("closes at exactly 60_000 ms after the latest inbound", () => {
    const closed = closedWindowForConversation("conv-1", [inbound("a", 0)], null, at(PREFILL_WINDOW_MS));
    expect(closed?.inboundIds).toEqual(["a"]);
  });

  it("returns null when an outbound arrives 30s after the inbound", () => {
    expect(
      closedWindowForConversation(
        "conv-1",
        [inbound("a", 0), outbound("o", 30_000)],
        null,
        at(30_000 + PREFILL_WINDOW_MS),
      ),
    ).toBeNull();
  });

  it("restarts the countdown when a new inbound arrives at 50s", () => {
    expect(
      closedWindowForConversation(
        "conv-1",
        [inbound("a", 0), inbound("b", 50_000)],
        null,
        at(50_000),
      ),
    ).toBeNull();
  });

  it("skips a window whose latest inbound is not newer than the watermark", () => {
    expect(
      closedWindowForConversation("conv-1", [inbound("a", 0)], at(0), at(PREFILL_WINDOW_MS)),
    ).toBeNull();
  });

  it("closes when the watermark is 1ms before the latest inbound", () => {
    const closed = closedWindowForConversation(
      "conv-1",
      [inbound("a", 0)],
      new Date(t0.getTime() - 1),
      at(PREFILL_WINDOW_MS),
    );
    expect(closed?.inboundIds).toEqual(["a"]);
  });

  it("ignores an inbound with a blank body", () => {
    expect(
      closedWindowForConversation(
        "conv-1",
        [
          {
            id: "blank",
            direction: "inbound",
            messageType: "text",
            textBody: "   ",
            providerTimestamp: at(0),
          },
        ],
        null,
        at(PREFILL_WINDOW_MS),
      ),
    ).toBeNull();
  });

  it("ignores inbound media as a window opener", () => {
    expect(
      closedWindowForConversation(
        "conv-1",
        [
          {
            id: "img",
            direction: "inbound",
            messageType: "image",
            textBody: null,
            providerTimestamp: at(0),
          },
        ],
        null,
        at(PREFILL_WINDOW_MS),
      ),
    ).toBeNull();
  });

  it("labels only inbounds after the last outbound before the latest inbound", () => {
    const closed = closedWindowForConversation(
      "conv-1",
      [inbound("old", 0), outbound("o", 10_000), inbound("a", 20_000), inbound("b", 40_000)],
      null,
      at(40_000 + PREFILL_WINDOW_MS),
    );

    expect(closed?.inboundIds).toEqual(["a", "b"]);
  });
});
