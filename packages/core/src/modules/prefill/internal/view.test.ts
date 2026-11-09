/**
 * Test design (testing-strategy)
 *
 * Setup: mapPrefillView / suggestionHasField / stripPrefillField. No HTTP.
 *
 * Oracle: assistive-cadastro-prefill GET mapping — in-flight wins over keys;
 * keys → pending; last job failed with zero keys → failed; else empty.
 * Pending with zero keys is empty. Accept of a missing key is 409 (hasField).
 *
 * Axes
 *   A1 inFlight yes/no
 *   A2 fields key count 0 vs ≥1
 *   A3 lastJobStatus failed vs succeeded vs null
 *
 * Outputs: O-extracting, O-pending, O-failed, O-empty; O-has / O-missing
 *
 * Sampled-cell
 *   in-flight + keys          | extracting | pending
 *   keys, not in-flight       | pending    | empty
 *   zero keys + failed        | failed     | empty
 *   zero keys + succeeded     | empty      | failed
 *   zero keys + null          | empty      | pending
 *   hasField plate present    | true       | false
 *   hasField plate absent     | false      | true
 *   strip plate               | plate gone | plate kept
 *
 * Decision map (view.ts)
 *   D1 inFlight                 T: in-flight it; F: the rest
 *   D2 keys.length > 0          T: pending it; F: failed/empty
 *   D3 lastJobStatus === failed T: failed it; F: succeeded / null empty
 *   D4 Object.hasOwn            T: present; F: absent
 *   D5 strip delete             T: plate present; F: strip missing key (no throw)
 *
 * Out of scope: Fastify inject (cadastro.prefill.test.ts).
 */
import { describe, expect, it } from "vitest";
import { mapPrefillView, stripPrefillField, suggestionHasField } from "./view.js";

describe("mapPrefillView", () => {
  it("returns extracting when a job is in flight even if keys exist", () => {
    expect(
      mapPrefillView({
        inFlight: true,
        fields: { plate: "ABC1D23" },
        lastJobStatus: "queued",
        extractEnabled: false,
      }),
    ).toEqual({ status: "extracting", extractEnabled: false });
  });

  it("returns pending when keys exist and nothing is in flight", () => {
    expect(
      mapPrefillView({
        inFlight: false,
        fields: { plate: "ABC1D23" },
        lastJobStatus: "succeeded",
        extractEnabled: false,
      }),
    ).toEqual({ status: "pending", fields: { plate: "ABC1D23" }, extractEnabled: false });
  });

  it("returns failed when the last job failed and no keys remain", () => {
    expect(
      mapPrefillView({
        inFlight: false,
        fields: {},
        lastJobStatus: "failed",
        extractEnabled: false,
      }),
    ).toEqual({ status: "failed", extractEnabled: false });
  });

  it("returns empty when there are no keys and the last job succeeded", () => {
    expect(
      mapPrefillView({
        inFlight: false,
        fields: {},
        lastJobStatus: "succeeded",
        extractEnabled: false,
      }),
    ).toEqual({ status: "empty", extractEnabled: false });
  });

  it("returns empty when there are no keys and no job", () => {
    expect(
      mapPrefillView({ inFlight: false, fields: {}, lastJobStatus: null, extractEnabled: false }),
    ).toEqual({
      status: "empty",
      extractEnabled: false,
    });
  });
});

describe("suggestionHasField", () => {
  it("is true when the key is on the suggestion", () => {
    expect(suggestionHasField({ plate: "ABC1D23" }, "plate")).toBe(true);
  });

  it("is false when the key is absent", () => {
    expect(suggestionHasField({ plate: "ABC1D23" }, "name")).toBe(false);
  });
});

describe("stripPrefillField", () => {
  it("removes the named key and leaves the others", () => {
    expect(stripPrefillField({ plate: "ABC1D23", make: "VW" }, "plate")).toEqual({ make: "VW" });
  });

  it("returns a copy when the named key is already absent", () => {
    expect(stripPrefillField({ plate: "ABC1D23" }, "name")).toEqual({ plate: "ABC1D23" });
  });
});
