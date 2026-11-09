/**
 * TEST DESIGN STRATEGY: pickEngineFillLiters (oil-quote D1)
 *
 * Oracle: oil-quote-liters-pricing D1 / spec "Engine fill liters come from Motul service fill"
 *   — motor only; em serviço over seco; unlabeled singleton; two unlabeled → null;
 *   transmission ignored; unparseable → null.
 *
 * Axes:
 *   Capacities (EP): none; one unlabeled; one em serviço; one seco; both legends;
 *     two unlabeled; unparseable volume; seco + unlabeled (no em serviço).
 *   Volume string (BVA): `3,70` comma; `4.70` dot; trailing `L`; empty; zero; negative.
 *   Category: motor vs transmissão (output: motor liters, never transmission).
 *
 * Outputs: O1 em_servico; O2 null-with-dry-readable; O3 unlabeled; O4 null.
 *
 * Sampled-cell table:
 *   both legends            | O1 4.2 em_servico | fails if seco 6.5 wins
 *   unlabeled 3,70         | O3 3.7 unlabeled  | fails if null
 *   motor 3.70 + AT 2.5     | O3 motor          | fails if 2.5
 *   two unlabeled            | O4 null           | fails if first volume
 *   empty volume             | O4 null           | fails if 0
 *   seco only                | O2 null, dry 6.5  | fails if 6.5 becomes a multiplier
 *
 * Decision map (pickEngineFillLiters):
 *   D1 motor missing / empty capacities     — empty-part it (T); unlabeled it (F)
 *   D2 parseCapacityLiters null            — empty volume it (T); 3,70 it (F)
 *   D3 first em_servico                    — both-legends it (T); seco-only it (F)
 *   D4 dry fill is never a multiplier      — seco-only it (null); pickDryFillLiters still reads 6.5
 *   D5 exactly one UNLABELED volume        — unlabeled it (T); two unlabeled it (F);
 *      seco+unlabeled it (T on the unlabeled one, proving seco is not counted)
 *   parseCapacityLiters: empty; ≤0; trailing L; comma vs dot
 *
 * Out of scope: live Motul HTTP; quote-options mapping of null → no_capacity.
 */
import { describe, expect, it } from "vitest";
import type { FlatRecommendation } from "./flatten.js";
import { parseCapacityLiters, pickDryFillLiters, pickEngineFillLiters } from "./pick-fill.js";

function recommendation(
  parts: FlatRecommendation["parts"],
): FlatRecommendation {
  return { vehicle: "fixture", parts };
}

describe("parseCapacityLiters", () => {
  it("parses a comma decimal", () => {
    expect(parseCapacityLiters("3,70")).toBe(3.7);
  });

  it("parses a dot decimal and a trailing L", () => {
    expect(parseCapacityLiters("4.70")).toBe(4.7);
    expect(parseCapacityLiters("4,70 L")).toBe(4.7);
  });

  it("rejects empty, zero, and negative volumes", () => {
    expect(parseCapacityLiters("")).toBeNull();
    expect(parseCapacityLiters("0")).toBeNull();
    expect(parseCapacityLiters("-1")).toBeNull();
    expect(parseCapacityLiters("abc")).toBeNull();
  });
});

describe("pickEngineFillLiters", () => {
  it("prefers volume em serviço over volume seco", () => {
    const picked = pickEngineFillLiters(
      recommendation({
        motor: {
          capacities: [
            { volume: "6,5", note: "Volume seco." },
            { volume: "4,2", note: "Volume em serviço." },
          ],
        },
      }),
    );
    expect(picked).toEqual({ liters: 4.2, kind: "em_servico" });
  });

  it("uses a single unlabeled motor volume", () => {
    const picked = pickEngineFillLiters(
      recommendation({
        motor: { capacities: [{ volume: "3,70" }] },
      }),
    );
    expect(picked).toEqual({ liters: 3.7, kind: "unlabeled" });
  });

  it("ignores transmission volumes", () => {
    const picked = pickEngineFillLiters(
      recommendation({
        motor: { capacities: [{ volume: "3,70" }] },
        "transmissão, automática": {
          capacities: [{ volume: "2,5", note: "Volume em serviço." }],
        },
      }),
    );
    expect(picked).toEqual({ liters: 3.7, kind: "unlabeled" });
  });

  it("returns null when two unlabeled motor volumes exist", () => {
    expect(
      pickEngineFillLiters(
        recommendation({
          motor: { capacities: [{ volume: "4,00" }, { volume: "3,00" }] },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when dry fill is the only motor volume", () => {
    const dryOnly = recommendation({
      motor: { capacities: [{ volume: "6,5", note: "Volume seco." }] },
    });

    // A troca de óleo is a drain-and-refill, so pouring 6,5 L would overfill and overquote.
    expect(pickEngineFillLiters(dryOnly)).toBeNull();
    // The volume is still readable for the source record, just not as a multiplier.
    expect(pickDryFillLiters(dryOnly)).toBe(6.5);
  });

  it("uses the unlabeled volume when dry fill sits beside it", () => {
    const secoAndUnlabeled = recommendation({
      motor: {
        capacities: [
          { volume: "6,5", note: "Volume seco." },
          { volume: "4,20" },
        ],
      },
    });

    expect(pickEngineFillLiters(secoAndUnlabeled)).toEqual({
      liters: 4.2,
      kind: "unlabeled",
    });
  });

  it("returns null when motor has no parseable liters", () => {
    expect(
      pickEngineFillLiters(
        recommendation({
          motor: { capacities: [{ volume: "" }] },
        }),
      ),
    ).toBeNull();
    expect(pickEngineFillLiters(recommendation({}))).toBeNull();
  });
});
