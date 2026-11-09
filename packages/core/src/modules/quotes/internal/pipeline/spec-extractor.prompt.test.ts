/**
 * Test design (testing-strategy) — the extractor's prompt names the picked engine (review of #197)
 *
 * SUT: `buildOilSpecPrompt`, pure.
 *
 * Oracle: the orchestrator's ruling of 2026-10-01: the engine_pick run always passes the picked
 *   engine to the extractor explicitly, so a pick whose version already names it is not a futile
 *   re-read; any other extraction's prompt is unchanged.
 *
 * Cells: with an engine | the engine line, after the vehicle and before the passage | without | no such line
 */
import { describe, expect, it } from "vitest";
import type { RetrievedSource } from "./oil-spec.js";
import { buildOilSpecPrompt } from "./spec-extractor.js";

const source: RetrievedSource = { publisher: "toyota.com.br", document: "Manual", page: "p. 412", content: { kind: "text", text: "1.8: 4,2 L; 2.0: 4,4 L" } };
const identity = { make: "Toyota", year: 2019, model: "Corolla", version: "XEi 1.8 Dual VVT-i" };

describe("buildOilSpecPrompt and the picked engine", () => {
  it("names the picked engine between the vehicle and the passage", () => {
    const lines = buildOilSpecPrompt(source, { ...identity, engine: "1.8 Dual VVT-i" }).split("\n");

    expect(lines[0]).toBe("veiculo_do_orcamento: Toyota Corolla 2019 XEi 1.8 Dual VVT-i");
    expect(lines[1]).toBe("motor_escolhido_pelo_atendente: 1.8 Dual VVT-i (leia os valores deste motor)");
    expect(lines.at(-1)).toBe("1.8: 4,2 L; 2.0: 4,4 L");
  });

  it("adds no engine line to any other extraction", () => {
    expect(buildOilSpecPrompt(source, identity)).not.toContain("motor_escolhido");
  });
});
