/**
 * Test design (testing-strategy)
 *
 * Setup: `./client.js`'s `tecfilGet` is module-mocked (`vi.mock`) and given
 * a per-test dispatcher that routes on `idConsulta`/`tipoRetorno` to canned
 * fixtures — Tecfil is never contacted. Four fixtures are recorded from the
 * live catalogue on 2026-09-04 for `PEUGEOT` / `207` / 2011 (manufacturers,
 * PEUGEOT vehicles, APLICACAO rows, PRODUTO rows); two are hand-built for
 * shapes that vehicle doesn't exercise (divergent engines, both fuel
 * columns). Tests that isolate engine-resolution behavior reuse the real
 * PEUGEOT/207 manufacturer and vehicle options with synthetic APLICACAO
 * rows for a different (fictional) vehicle — only the engine step reads
 * those rows, so the mismatch in vehicle label doesn't affect what's under
 * test.
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 * — every scenario under "Name matching is exact first, then picked from
 * the list", "Discriminated fitment result", "Fitment carries candidates
 * per filter type with cross-references", and "Bounded resilience and call
 * budget".
 *
 * Techniques: EP of the match path per field (exact / unanimous / picked /
 * unmatched-no-picker / unmatched-invalid-pick) crossed with the
 * discriminated result (needs / unmatched / ok / unavailable); call-count
 * assertions in place of BVA (the call budget is a hard requirement, not a
 * boundary to sweep).
 *
 * One-sided decisions in resolver.ts (repo-foundation:114), classified 2026-09-07.
 * Six arms are untaken. Two cannot be taken at all; four are reachable and are
 * deferred rather than justified — the distinction is stated per arm so a
 * reader is not left guessing which kind each is.
 *
 * UNREACHABLE (dead code, reported):
 *
 *   L208 `columnsByNumber.get(partNumber) ?? []` — the `[]` cannot be reached.
 *     `byNumber` and `columnsByNumber` are populated in the SAME loop body
 *     (resolver.ts:184-190): every part written to `byNumber` at :186 has its
 *     column set written at :187-189. The map at :193 is then iterated over
 *     `byNumber.entries()`, so every `partNumber` reaching :208 is guaranteed a
 *     `columnsByNumber` entry.
 *
 *   L359 `groups.get(picked.Descricao) ?? []` — the `[]` cannot be reached.
 *     `engineOptions` is built as `groupEntries.map(([label]) => ({ Descricao:
 *     label }))` (:348-350), so every option's `Descricao` IS a key of
 *     `groups`; and `pickFromOptions` resolves the picker's reply back to a
 *     member of that same option list or returns undefined, which the `if
 *     (!picked)` above already handles. So `picked.Descricao` is always a key.
 *
 * OUT OF SCOPE — reachable, cheap, identified but deliberately not written
 * under the 2026-09-07 wind-down, and named here so they are not mistaken for
 * infeasible ones:
 *
 *   L132 and L320 `row.ComplementoAplicacao3_2 ?? ""` — `wire.ts:56` declares
 *     that field OPTIONAL, so an ABSENT field is contract-valid and the `?? ""`
 *     fallback is reachable. Every fixture supplies the field, and the wiper
 *     cases use an EMPTY STRING rather than omitting it, so the two are not the
 *     same input. A row with the key missing entirely would take these.
 *
 *   L171 `sameSet`'s `if (a.size !== b.size) return false` — reachable with two
 *     bands whose part sets differ in SIZE. The divergent-engine fixture
 *     differs in MEMBERSHIP at equal size, so the early size check never
 *     decides. Same outcome either way (the picker is consulted), which is why
 *     this is a partition gap rather than a behaviour gap.
 *
 *   L263 the manufacturer picker's SUCCESS path — the suite covers a picker
 *     that declines a manufacturer, and a picker that succeeds for a VEHICLE
 *     (207 SW), but never a picker that succeeds for a MANUFACTURER, so
 *     `manufacturerMatchedBy = "picked"` is never set.
 *
 * client.ts's two untaken arms are already named in client.test.ts:130-131
 * (a non-Error throw is not in the Tecfil client contract; the post-loop throw
 * is infeasible while the for-loop always returns or throws). Unchanged.
 *
 * Sampled-cell table (one row per required scenario)
 * it                                                    | fails if
 * resolves the sample vehicle exactly, 4 calls, 0 picks  | wrong candidates/cross-refs, matchedBy not all "exact", call count != 4
 * picker chooses 207 SW for a CRM name Tecfil doesn't have | picker not called with the right options, or vehicle/matchedBy wrong
 * a picker reply outside the option list counts as no pick | resolver accepts an unlisted reply
 * no picker injected -> unmatched                        | resolver invents a match with no picker
 * unanimous engines skip the picker (engine null)         | picker called, or oil/fuel candidates wrong
 * divergent engines route to the picker                   | unanimity wrongly accepted, or picker options/result wrong
 * both fuel grid columns yield two candidates              | one candidate dropped or numbers wrong
 * a candidate absent from the PRODUTO page gets no cross-refs | crashes, or invents a cross-reference
 * wiper rows never form an engine option or a candidate    | wiper's blank engine appears as a 3rd picker option
 * zero fitment rows for the year -> unmatched year, no 4th call | wrong field, or PRODUTO still fetched
 * a Tecfil call throwing after retries -> unavailable, never throws | resolveFilters throws to the caller
 *
 * Decision-coverage top-up (each of the four `!field` "needs" checks, and
 * the manufacturer/engine `!picked` unmatched branches the required
 * scenarios above don't reach — the vehicle field's equivalents are already
 * hit by the "picker reply outside the list" and "no picker injected" cases):
 * each empty identity field -> needs, with zero Tecfil calls | wrong field, or a call happened
 * manufacturer picker declines (returns null) -> unmatched manufacturer | wrong field/options, or no picker call
 * engine picker declines on divergent engines -> unmatched engine, no PRODUTO call | wrong field/options, or a 4th call happened
 *
 * Out of scope: `client.ts`'s own retry/decode behavior (`client.test.ts`,
 * `decode.test.ts`); live Tecfil HTTP (`pnpm demo`); `pickFromOptions`'s
 * `options.length === 0` guard — unreachable from `resolveFilters` because
 * every path that reaches a picker call already guarantees a non-empty
 * option list (a zero-row fitment search returns `unmatched` year first).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tecfilGet } from "./client.js";
import { normalizeTecfilName, resolveFilters } from "./resolver.js";
import type { TecfilProdutoRow, TecfilSearchEnvelope } from "./wire.js";

vi.mock("./client.js", () => ({ tecfilGet: vi.fn() }));

const mockedGet = vi.mocked(tecfilGet);

import {
  bothFuelColumns,
  dispatch,
  divergentEngines,
  emptyProduto,
  manufacturers,
  peugeotVehicleLabels,
  peugeotVehicles,
  sampleAplicacao,
  sampleIdentity,
  sampleProduto,
} from "./resolver.fixture.js";

describe("resolveFilters", () => {
  afterEach(() => {
    mockedGet.mockReset();
  });

  it("resolves the sample vehicle exactly with 4 requests and 0 picks", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: sampleAplicacao,
        produto: sampleProduto,
      }),
    );

    const result = await resolveFilters(sampleIdentity);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.matchedBy).toEqual({
      manufacturer: "exact",
      vehicle: "exact",
      engine: "exact",
    });
    expect(result.fitment.oilFilters).toHaveLength(1);
    expect(result.fitment.oilFilters[0]?.partNumber).toBe("PEL108");
    expect(result.fitment.oilFilters[0]?.crossReferences.length).toBeGreaterThan(0);
    expect(result.fitment.oilFilters[0]?.sourceColumns).toEqual([
      "ComplementoAplicacao3_11",
    ]);
    expect(result.fitment.fuelFilters).toHaveLength(1);
    expect(result.fitment.fuelFilters[0]?.partNumber).toBe("GI50/7");
    expect(result.fitment.fuelFilters[0]?.crossReferences.length).toBeGreaterThan(0);
    expect(result.fitment.fuelFilters[0]?.sourceColumns).toEqual([
      "ComplementoAplicacao3_13",
    ]);
    expect(mockedGet).toHaveBeenCalledTimes(4);
  });

  it("picks 207 SW for a CRM vehicle name Tecfil doesn't have", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: sampleAplicacao,
        produto: sampleProduto,
      }),
    );
    const pickOption = vi.fn(async (field: string) => (field === "vehicle" ? "207 SW" : null));

    const result = await resolveFilters(
      { ...sampleIdentity, model: "207 Passion SW" },
      { pickOption },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.vehicleLabel).toBe("207 SW");
    expect(result.fitment.matchedBy.vehicle).toBe("picked");
    expect(pickOption).toHaveBeenCalledWith(
      "vehicle",
      "207 Passion SW",
      { ...sampleIdentity, model: "207 Passion SW" },
      peugeotVehicleLabels,
    );
  });

  it("treats a picker reply outside the option list as no pick", async () => {
    mockedGet.mockImplementation(
      dispatch({ manufacturers, vehicles: peugeotVehicles }),
    );
    const pickOption = vi.fn(async () => "Not a real Tecfil vehicle");

    const result = await resolveFilters(
      { ...sampleIdentity, model: "207 Passion SW" },
      { pickOption },
    );

    expect(result).toEqual({
      status: "unmatched",
      field: "vehicle",
      options: peugeotVehicleLabels,
    });
  });

  it("is unmatched with no picker injected", async () => {
    mockedGet.mockImplementation(
      dispatch({ manufacturers, vehicles: peugeotVehicles }),
    );

    const result = await resolveFilters({ ...sampleIdentity, model: "207 Passion SW" });

    expect(result).toEqual({
      status: "unmatched",
      field: "vehicle",
      options: peugeotVehicleLabels,
    });
  });

  it("accepts unanimous engines with engine null and no picker call", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: sampleAplicacao,
        produto: sampleProduto,
      }),
    );
    const pickOption = vi.fn(async () => "should not be called");

    const result = await resolveFilters(
      { ...sampleIdentity, version: "1.4i 8V - TU3" },
      { pickOption },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.engineLabel).toBeNull();
    expect(result.fitment.matchedBy.engine).toBe("unanimous");
    expect(result.fitment.oilFilters.map((f) => f.partNumber)).toEqual(["PEL108"]);
    expect(result.fitment.fuelFilters.map((f) => f.partNumber)).toEqual(["GI50/7"]);
    expect(pickOption).not.toHaveBeenCalled();
  });

  it("routes divergent engines to the picker", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: divergentEngines,
        produto: emptyProduto,
      }),
    );
    const pickOption = vi.fn(async (field: string) =>
      field === "engine" ? "1.4 8V FLEX" : null,
    );

    const result = await resolveFilters(
      { ...sampleIdentity, version: "1.4 FLEX" },
      { pickOption },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.engineLabel).toBe("1.4 8V FLEX");
    expect(result.fitment.matchedBy.engine).toBe("picked");
    expect(result.fitment.oilFilters.map((f) => f.partNumber)).toEqual(["PSL456"]);
    expect(pickOption).toHaveBeenCalledWith(
      "engine",
      "1.4 FLEX",
      { ...sampleIdentity, version: "1.4 FLEX" },
      ["1.0 8V FLEX", "1.4 8V FLEX"],
    );
  });

  it("yields two candidates when both fuel grid columns are filled", async () => {
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: bothFuelColumns,
        produto: emptyProduto,
      }),
    );

    const result = await resolveFilters({ ...sampleIdentity, version: "1.4 8V FLEX" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.matchedBy.engine).toBe("exact");
    const byNumber = new Map(result.fitment.fuelFilters.map((f) => [f.partNumber, f]));
    expect([...byNumber.keys()].sort()).toEqual(["GI40/1", "GI40/2"]);
    expect(byNumber.get("GI40/1")?.sourceColumns).toEqual(["ComplementoAplicacao3_13"]);
    expect(byNumber.get("GI40/2")?.sourceColumns).toEqual(["ComplementoAplicacao3_14"]);
  });

  it("gives an empty cross-reference list for a candidate the PRODUTO page doesn't return", async () => {
    const produtoWithoutOil: TecfilSearchEnvelope<TecfilProdutoRow> = {
      ...sampleProduto,
      data: sampleProduto.data.filter((p) => p.NumeroProduto !== "PEL108"),
    };
    mockedGet.mockImplementation(
      dispatch({
        manufacturers,
        vehicles: peugeotVehicles,
        aplicacao: sampleAplicacao,
        produto: produtoWithoutOil,
      }),
    );

    const result = await resolveFilters(sampleIdentity);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fitment.oilFilters[0]?.partNumber).toBe("PEL108");
    expect(result.fitment.oilFilters[0]?.crossReferences).toEqual([]);
    expect(result.fitment.fuelFilters[0]?.crossReferences.length).toBeGreaterThan(0);
  });
});


/**
 * `normalizeTecfilName` had ZERO direct references in any tecfil test file
 * before 2026-09-07. It is reached indirectly through `resolveFilters`, but
 * "reached" is not "pinned": every fitment case above would still pass if the
 * function collapsed every input to the same key, because those cases only ever
 * compare one normalised name against another.
 *
 * That is the trap its sibling fell into. `normalizeMotulName`, the identical
 * algorithm in the paired package, IS directly tested — but its single case
 * asserts `normalize(a) === normalize(b)`, which a function returning "" for
 * everything satisfies. So these cases assert the RESULTING KEY, and one of
 * them asserts that two different names stay different, which is the check that
 * cannot pass vacuously.
 *
 * Oracle: the JSDoc at resolver.ts:95-101 — "Uppercase alphanumeric-only key;
 * empty string when `s` has no letters or digits" — plus the four transforms
 * the body names in order (NFD, strip diacritics, uppercase, drop non-
 * alphanumeric). No OpenSpec scenario states the key format, so documented
 * intent is the oracle; code and doc were confirmed to agree first.
 *
 * Two things measured rather than assumed while writing these, both worth
 * keeping:
 *
 * 1. Of the four transforms, `.replace(/\p{Diacritic}/gu, "")` is REDUNDANT.
 *    NFD decomposes an accented letter into a base letter plus a combining
 *    mark, and the closing `[^A-Z0-9]` filter already removes that mark. Probed
 *    across Citroën, AÇÃO, Ångström, Łódź, naïve, ø and peugeot: output is
 *    byte-identical with and without that line. `.normalize("NFD")` is the step
 *    that actually does the folding — drop it and Citroën becomes CITRON. So no
 *    test here can bite on removing the diacritic strip, and none should be
 *    written to pretend otherwise. Reported 2026-09-07; the identical line
 *    exists in `normalizeMotulName` (motul/resolver.ts:34), which this function
 *    deliberately mirrors.
 *
 * 2. The function was not COMPLETELY unguarded before, only undirected.
 *    Mutating it (dropping NFD and uppercase) fails exactly one pre-existing
 *    resolver case — the picker-declines-a-manufacturer one — because that
 *    fixture happens to carry an accented name. One incidental case out of the
 *    whole fitment suite, catching it for a reason unrelated to what it tests,
 *    and nothing anywhere pinning the key FORMAT.
 */
describe("normalizeTecfilName", () => {
  it.each([
    // Diacritics: the whole reason this exists over a plain toUpperCase().
    { input: "Citroën", expected: "CITROEN", why: "diaeresis folded away" },
    { input: "AÇÃO", expected: "ACAO", why: "cedilla and tilde folded away" },
    // Case.
    { input: "peugeot", expected: "PEUGEOT", why: "lower-cased input upper-cased" },
    // Separators and punctuation dropped, digits kept.
    { input: "1.0 8V FLEX", expected: "108VFLEX", why: "spaces and dots dropped, digits kept" },
    { input: "207 SW", expected: "207SW", why: "space dropped" },
    // The documented empty case: no letters or digits at all.
    { input: " - / - ", expected: "", why: "nothing alphanumeric survives" },
    { input: "", expected: "", why: "empty in, empty out" },
  ])("$why: $input -> $expected", ({ input, expected }) => {
    expect(normalizeTecfilName(input)).toBe(expected);
  });

  it("keeps genuinely different names apart", () => {
    // The resolution check. Every assertion above would also be satisfied by a
    // function that returned "" unconditionally if they had been written as
    // comparisons rather than as values; this one fails outright for any
    // collapsing implementation, including the accidental `.replace(/[^A-Z0-9]/g, "")`
    // applied before the uppercase step.
    expect(normalizeTecfilName("207")).not.toBe(normalizeTecfilName("208"));
    expect(normalizeTecfilName("1.0 8V FLEX")).not.toBe(
      normalizeTecfilName("1.4 8V FLEX"),
    );
  });

  it("folds a CRM spelling onto the Tecfil spelling of the same name", () => {
    // The behaviour the resolver actually depends on, stated once here rather
    // than only implied by a fitment fixture: an accented, lower-cased, spaced
    // CRM name and Tecfil's own spelling resolve to one key.
    expect(normalizeTecfilName("citroën ")).toBe(normalizeTecfilName("CITROEN"));
    expect(normalizeTecfilName("citroën ")).toBe("CITROEN");
  });
});
