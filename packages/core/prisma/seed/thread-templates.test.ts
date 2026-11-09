/**
 * Test design (testing-strategy)
 *
 * Setup: pure template render + faker distractors. No Prisma. Fetch is mocked
 * around compose so a network call would fail the suite.
 *
 * Oracle: demo-seed workshop mix — bare 1–4 and no vehicle facts; other
 * archetypes 5–20; each trap distractor ≠ stored plate/vehicle/name/phone/street
 * (or chat key when there is no customer); typos skip identifier slots; no LLM.
 *
 * Axes
 *   A1 archetype — bare / true-positive / each trap / each leftover
 *   A2 register — typos on / off
 *   A3 stored cadastro — full ficha / phone-only
 *   A4 distractor draw — first candidate differs / every candidate collides
 *
 * Decision map
 *   D1 applyTypos          true: abbreviations present   false: clean “você”
 *   D2 identifier token    true: plate unchanged         false: surrounding text may change
 *   D3 pickDisagreeing     match → retry/suffix          no match → keep
 *   D4 length band         bare → 1–4                    else → 5–20
 */
import { describe, expect, it, vi } from "vitest";
import { resetDemoFaker } from "./faker.js";
import {
  applyInternetPortugueseTypos,
  BARE_THREAD_LENGTH,
  blurbForArchetype,
  drawTrapDistractors,
  NON_BARE_THREAD_LENGTH,
  pickDisagreeingValue,
  planWorkshopSeedThread,
  renderWorkshopThread,
  type StoredCadastro,
  type TrapDistractors,
} from "./thread-templates.js";
import { PRIMARY_THREAD_ARCHETYPES, type ThreadArchetype } from "./thread-archetypes.js";

const ANCHOR = new Date("2026-09-01T15:00:00.000Z");

const STORED: StoredCadastro = {
  name: "Ana Souza",
  plate: "ABC1D23",
  make: "Volkswagen",
  model: "Polo",
  year: 2018,
  street: "Rua Conceição",
  extraMake: "Fiat",
  extraModel: "Argo",
  extraYear: 2021,
  chatKey: "5519000000001",
};

const PHONE_ONLY: StoredCadastro = {
  name: null,
  plate: null,
  make: null,
  model: null,
  year: null,
  street: null,
  extraMake: null,
  extraModel: null,
  extraYear: null,
  chatKey: "5519000000001",
};

const DISTRACTORS: TrapDistractors = {
  plate: "QRM2N34",
  make: "Honda",
  model: "Civic",
  year: 2015,
  name: "João Lima",
  phone: "5511999887766",
  street: "Rua das Laranjeiras",
  shop: "Oficina Central",
  relation: "esposa",
};

const ALL_ARCHETYPES: ThreadArchetype[] = [
  ...PRIMARY_THREAD_ARCHETYPES,
  "leftoverScheduling",
  "leftoverReturn",
  "leftoverPriceCheck",
];

function rendered(archetype: ThreadArchetype, applyTypos = false) {
  return renderWorkshopThread({
    archetype,
    stored: STORED,
    distractors: DISTRACTORS,
    applyTypos,
  });
}

function joined(archetype: ThreadArchetype, applyTypos = false) {
  return rendered(archetype, applyTypos)
    .lines.map((line) => line.text)
    .join("\n");
}

describe("renderWorkshopThread length bands", () => {
  it.each(ALL_ARCHETYPES)("%s stays in the spec length band", (archetype) => {
    const { lines } = rendered(archetype);
    const band = archetype === "bareHours" ? BARE_THREAD_LENGTH : NON_BARE_THREAD_LENGTH;

    expect(lines.length).toBeGreaterThanOrEqual(band.min);
    expect(lines.length).toBeLessThanOrEqual(band.max);
  });

  it("keeps leftover scripts as distinct templates", () => {
    expect(joined("leftoverScheduling")).not.toBe(joined("leftoverReturn"));
    expect(joined("leftoverReturn")).not.toBe(joined("leftoverPriceCheck"));
  });
});

describe("bare-hours bodies", () => {
  it("contain no plate and no vehicle identity", () => {
    const body = joined("bareHours");

    expect(body).not.toMatch(/placa/i);
    expect(body).not.toContain(STORED.plate);
    expect(body).not.toContain(STORED.make);
    expect(body).not.toContain(STORED.model);
    expect(body).not.toMatch(/[A-Z]{3}\d[A-Z0-9]\d{2}/i);
  });
});

describe("true-positive extract", () => {
  it("mentions the stored plate and vehicle", () => {
    const body = joined("truePositive");

    expect(body).toContain("ABC1D23");
    expect(body).toContain("Volkswagen");
    expect(body).toContain("Polo");
    expect(body).toContain("Ana Souza");
  });
});

describe("trap distractors disagree with the ficha", () => {
  it("rejects a candidate that matches the stored value and uses the reserved suffix", () => {
    expect(
      pickDisagreeingValue({
        generate: () => "ABC1D23",
        matches: (value) => value === "ABC1D23",
        fallback: "XSEED",
      }),
    ).toBe("ABC1D23XSEED");
  });

  it.each([
    ["formerVehicle", (body: string) => body.includes("Honda") && body.includes("Civic") && !body.includes("Polo")],
    ["familyCar", (body: string) => body.includes("Civic") && !body.includes("Polo")],
    ["thirdPartyPlate", (body: string) => body.includes("QRM2N34") && !body.includes("ABC1D23")],
    ["someoneElseNamePhone", (body: string) => body.includes("João Lima") && body.includes("5511999887766") && !body.includes("Ana Souza")],
    ["destinationNotHome", (body: string) => body.includes("Rua das Laranjeiras") && !body.includes("Rua Conceição")],
    ["otherShopQuote", (body: string) => body.includes("Oficina Central")],
  ] as const)("%s distractor is not the stored cadastro", (archetype, check) => {
    expect(check(joined(archetype))).toBe(true);
  });

  it("draws values that differ from stored plate, vehicle, name, phone, and street", () => {
    const faker = resetDemoFaker();

    const drawn = drawTrapDistractors(STORED, faker);

    expect(drawn.plate.toUpperCase()).not.toBe("ABC1D23");
    expect(`${drawn.make} ${drawn.model} ${drawn.year}`.toLowerCase()).not.toBe("volkswagen polo 2018");
    expect(`${drawn.make} ${drawn.model} ${drawn.year}`.toLowerCase()).not.toBe("fiat argo 2021");
    expect(drawn.name.toLowerCase()).not.toBe("ana souza");
    expect(drawn.phone.replace(/\D/g, "")).not.toBe("5519000000001");
    expect(drawn.street.toLowerCase()).not.toBe("rua conceição");
  });

  it("rejects a distractor phone that equals the chat key when there is no customer", () => {
    const faker = resetDemoFaker();

    const drawn = drawTrapDistractors(PHONE_ONLY, faker);

    expect(drawn.phone.replace(/\D/g, "")).not.toBe("5519000000001");
    expect(drawn.plate.replace(/[^a-zA-Z0-9]/g, "")).not.toBe("5519000000001");
  });

  it("returns the same distractors after a faker reset", () => {
    const first = drawTrapDistractors(STORED, resetDemoFaker());
    const second = drawTrapDistractors(STORED, resetDemoFaker());

    expect(second).toEqual(first);
  });
});

describe("register transform", () => {
  it("puts a known abbreviation on a mistyped thread and leaves a clean thread untouched", () => {
    const mistyped = joined("bareHours", true);
    const clean = joined("truePositive", false);

    expect(mistyped).toMatch(/\bvc\b|\bpfv\b|\bpra\b/);
    expect(clean).toContain("você");
    expect(clean).not.toMatch(/\bvc\b/);
  });

  it("leaves a true-positive plate exactly the stored plate when typos run", () => {
    const body = joined("truePositive", true);

    expect(body).toContain("ABC1D23");
    expect(applyInternetPortugueseTypos("A placa é {{plate}}.")).toContain("{{plate}}");
  });
});

describe("planWorkshopSeedThread", () => {
  it("builds deterministic SEED rows and opens no language-model network", () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;

    const input = {
      conversationId: "live-conv-01",
      anchor: ANCHOR,
      archetype: "truePositive" as const,
      stored: STORED,
      distractors: DISTRACTORS,
      applyTypos: false,
    };
    const first = planWorkshopSeedThread(input);
    const second = planWorkshopSeedThread(input);

    expect(second).toEqual(first);
    expect(first.some((row) => row.direction === "outbound")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
  });

  it("labels unanswered bare-hours inbound with shouldReply", () => {
    const planned = planWorkshopSeedThread({
      conversationId: "live-conv-02",
      anchor: ANCHOR,
      archetype: "bareHours",
      stored: PHONE_ONLY,
      distractors: DISTRACTORS,
      applyTypos: false,
    });

    expect(planned.every((row) => row.direction === "inbound")).toBe(true);
    expect(planned.every((row) => row.shouldReply === true)).toBe(true);
  });
});

describe("blurbForArchetype", () => {
  it("returns a one-line description without a phone", () => {
    const blurb = blurbForArchetype("someoneElseNamePhone");

    expect(blurb.length).toBeGreaterThan(0);
    expect(blurb).not.toMatch(/\d{8,15}/);
  });
});
