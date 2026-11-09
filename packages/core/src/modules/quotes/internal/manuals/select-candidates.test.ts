/**
 * Test design (testing-strategy) — which manuals an identity queues (D1)
 *
 * SUT: chooseManuals, pure.
 *
 * Oracle: oil-manual-ingestion "Only a manufacturer manual that names the vehicle is ingested",
 *   with the Q5 cases from the real 2026-09-25 candidates:
 *   - a manual for another model is not read (T-Cross for a Gol);
 *   - the label decides over the URL ("Manual Voyage 2015" under /manual-gol/ is not a Gol manual);
 *   - the workshop country's manual comes first (vw.com.br before volkswagen.com.ar), and the
 *     foreign one stays eligible second;
 *   - a year match ranks first; only tier 1–2 manufacturer documents qualify; N per identity;
 *   - "Gol" is a word, so "Golf" does not match; a repeat find counts once.
 */
import { describe, expect, it } from "vitest";
import { chooseManuals, type ManualCandidateRow } from "./select-candidates.js";

const gol = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const at = (n: number) => new Date(Date.UTC(2026, 8, 25, 12, n));
const row = (url: string, label: string | null, n: number, extra: Partial<ManualCandidateRow> = {}): ManualCandidateRow => ({
  url,
  label,
  classification: "manufacturer_manual",
  tier: 1,
  foundAt: at(n),
  ...extra,
});

const VW = "https://www.vw.com.br/idhub/content/dam/onehub_pkw/importers/br/literatura-de-bordo";
const GOL_2021 = row(`${VW}/manual-gol/GOL_MY%202021_21A.5B1.GOL.66.pdf`, "Faz o download de um arquivo Manual Gol 2021", 1);
const GOL_2020 = row(`${VW}/manual-gol/MY%202020_20A.5B1.GOL.66.pdf`, "Faz o download de um arquivo Manual Gol 2020", 2);
const TCROSS = row(`${VW}/manual-t-cross/T-Cross_MY%202021_21C.5B1.TCR.66.pdf`, "Faz o download de um arquivo Manual T-Cross 2021", 3);
const VOYAGE_UNDER_GOL = row(`${VW}/manual-gol/my-2015_154-5b1-gol-66.pdf`, "Faz o download de um arquivo Manual Voyage 2015", 4);
const AR_GOL_2021 = row("https://www.volkswagen.com.ar/idhub/content/dam/onehub_pkw/importers/ar/manuales/2021/Manual%20Gol%202021.pdf", null, 0);

describe("chooseManuals", () => {
  it("does not read a manual for another model", () => {
    expect(chooseManuals([TCROSS, GOL_2021], gol, 5)).toEqual([GOL_2021.url]);
  });

  it("lets the label decide over the URL: a Voyage manual under /manual-gol/ is not a Gol manual", () => {
    expect(chooseManuals([VOYAGE_UNDER_GOL], gol, 5)).toEqual([]);
  });

  it("reads the unlabelled manual by its URL", () => {
    expect(chooseManuals([AR_GOL_2021], gol, 5)).toEqual([AR_GOL_2021.url]);
  });

  it("puts the workshop country's manual first, and keeps the foreign one second", () => {
    // The AR one was found first and matches the year too; the domain decides.
    expect(chooseManuals([AR_GOL_2021, GOL_2021], gol, 2)).toEqual([GOL_2021.url, AR_GOL_2021.url]);
  });

  it("ranks a year match first", () => {
    expect(chooseManuals([GOL_2020, GOL_2021], gol, 1)).toEqual([GOL_2021.url]);
  });

  it("queues at most the limit", () => {
    expect(chooseManuals([GOL_2021, GOL_2020, AR_GOL_2021], gol, 2)).toHaveLength(2);
  });

  it.each([
    ["a tier-3 source", { tier: 3 }],
    ["a lubricant maker's guide", { classification: "lubricant_maker_guide" }],
  ])("does not read %s", (_label, extra) => {
    expect(chooseManuals([{ ...GOL_2021, ...extra }], gol, 5)).toEqual([]);
  });

  it("reads Gol as a word, so a Golf manual is not a Gol manual", () => {
    expect(chooseManuals([row(`${VW}/golf.pdf`, "Manual Golf 2021", 1)], gol, 5)).toEqual([]);
  });

  it("ranks a whitespace-only label as no label", () => {
    const blank = row(`${VW}/manual-gol/gol-a.pdf`, "   ", 1);
    const labelled = row(`${VW}/manual-gol/gol-b.pdf`, "Manual Gol", 2);

    expect(chooseManuals([blank, labelled], gol, 2)).toEqual([labelled.url, blank.url]);
  });

  it("counts a repeat find once", () => {
    expect(chooseManuals([GOL_2021, { ...GOL_2021, foundAt: at(9) }], gol, 5)).toEqual([GOL_2021.url]);
  });
});
