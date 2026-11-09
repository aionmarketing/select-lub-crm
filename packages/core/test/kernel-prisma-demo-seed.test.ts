/**
 * Test design (testing-strategy)
 *
 * Setup: pure planners (no Postgres). Live DMMF/idempotency live in
 * demo-seed.live.test.ts when DATABASE_URL is set.
 *
 * Oracle: seed-demo-data — faker pt_BR fixed seed; demo instance names
 * never equal EVOLUTION_INSTANCE_NAME; SEED_DEMO=0 skips demo.
 *
 * Axes
 *   A1 planner calls — 1 vs 2
 *   A2 live instance name — distinct vs colliding suffix
 *   A5 TIDSCI opt-in — SEED_DEMO off skips even with OMIE_MOCK_DATASET=tidsci;
 *     demo.ts never names TIDSCI EMP0N units
 *   A6 mock dataset completeness — every required identifier present vs one
 *     surface missing. Oracle: demo-seed "Every mocked Omie surface has demo
 *     data". The missing case is reached by passing a pruned dataset to
 *     `mockOmieSeedPlan`, which takes it as a defaulted parameter for that
 *     purpose — no module mocking, and production callers pass nothing.
 *
 * Outputs: O1 identical names; O2 no live collision; O3 toggle; O4 throws
 * naming the missing identifier rather than seeding a partial surface
 *
 * Unautomated, with reasons:
 *   Live `pnpm db:seed` twice against Postgres —
 *   `demo-seed.live.test.ts` when `DATABASE_URL` is set. Its table-count
 *   equality can fail when other live tests write WebhookEvent/Message rows to
 *   the same DATABASE_URL in parallel; an isolated re-run is the
 *   seed-idempotency oracle.
 *
 *   `seedDemoDataset` (prisma/seed/demo.ts) and `seedMockOmieDataset` are NOT
 *   sampled here. Their contract in demo-seed is stated as properties of the
 *   resulting database — every model has rows, a second run changes no count,
 *   at least three conversations have a null customerId — which only a real
 *   Postgres can observe; `demo-seed.live.test.ts` calls `seedDemoDataset`,
 *   which calls `seedMockOmieDataset` in turn. A unit test would have to stand
 *   up a fake Prisma client and could then only assert which upsert arguments
 *   were passed, i.e. the implementation. The decision-carrying parts of the
 *   seed are already extracted and covered at 100%: plan.ts, connections.ts,
 *   env.ts, faker.ts, and now mock-omie's planner.
 *
 *   `upsertMockCustomer`'s P2002 catch is reachable only when a CustomerPhone
 *   row already exists for that number, i.e. under pre-existing data or a
 *   concurrent writer. A single-process seed cannot reach it with legal input,
 *   so no hollow case is added.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockOmieDataset } from "../src/kernel/clients/erp-mock/mock/dataset.js";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { prefillFieldsSchema } from "../src/modules/prefill/contracts/http.js";
import { DEMO_COVERED_MODELS, DEMO_PREFILL_PENDING_FIELDS } from "../prisma/seed/demo.js";
import { mockOmieSeedPlan } from "../prisma/seed/mock-omie.js";
import { demoInstanceNames } from "../prisma/seed/connections.js";
import { isDemoSeedEnabled, shouldFollowTidsciMockImport } from "../prisma/seed/env.js";
import { planDemoCustomers, sliceHasService, sliceHasVehicle } from "../prisma/seed/plan.js";

describe("planDemoCustomers", () => {
  it("returns the same names and plates on two calls", () => {
    const first = planDemoCustomers(20);
    expect(first).toEqual(planDemoCustomers(20));
    expect(first).toHaveLength(20);
    expect(first.filter((row) => row.plate === null)).toHaveLength(4);
  });

  it("plans as many identities as there are conversations, including none", () => {
    // Volume follows the conversations now: `demo-seed` says "with more
    // conversations it creates more customers, and with none it creates none".
    expect(planDemoCustomers(0)).toHaveLength(0);
    expect(planDemoCustomers(7)).toHaveLength(7);
    expect(planDemoCustomers(300)).toHaveLength(300);
  });

  it("carries no phone, because a decorated customer takes its conversation's real one", () => {
    // The one field the seed must not invent. If this type ever regains a
    // `phone`, the decoration would quietly start writing a fabricated number
    // over a real one.
    expect(planDemoCustomers(3)[0]).not.toHaveProperty("phone");
    expect(planDemoCustomers(3)[0]?.taxId).toEqual(expect.any(String));
  });

  it("plans a workshop completeness mix", () => {
    const customers = planDemoCustomers(20);
    const thin = customers.filter((row) => row.slice === "thin");
    const partial = customers.filter((row) => row.slice === "partial");
    const active = customers.filter((row) => row.slice === "active");
    const rich = customers.filter((row) => row.slice === "rich");

    expect(thin.length).toBeGreaterThanOrEqual(3);
    expect(partial.length).toBeGreaterThanOrEqual(3);
    expect(active.length).toBeGreaterThanOrEqual(3);
    expect(rich).toHaveLength(1);
    expect(thin.every((row) => row.email === null && row.plate === null && !sliceHasVehicle(row.slice))).toBe(
      true,
    );
    expect(partial.every((row) => sliceHasVehicle(row.slice) && !sliceHasService(row.slice))).toBe(true);
    expect(active.every((row) => sliceHasService(row.slice))).toBe(true);
    expect(rich[0]?.email).toEqual(expect.any(String));
    expect(rich[0]?.plate).toEqual(expect.any(String));
  });

  it("keeps the mix proportional at any volume, and every slice present at small ones", () => {
    // The point of proportional over absolute: on a phone with hundreds of
    // conversations the demo must not become ~97% one slice, or the thin and
    // partial states stop being visible while demoing.
    const large = planDemoCustomers(300);
    const share = (slice: string) => large.filter((row) => row.slice === slice).length / 300;
    expect(share("rich")).toBeCloseTo(0.05, 2);
    expect(share("thin")).toBeCloseTo(0.2, 2);
    expect(share("partial")).toBeCloseTo(0.2, 2);
    expect(share("active")).toBeCloseTo(0.55, 2);

    // Each share floors at one, so a handful of conversations still shows every
    // state — a demo missing the thin ficha cannot show pré-cadastro at all.
    const small = planDemoCustomers(4).map((row) => row.slice);
    expect(new Set(small)).toEqual(new Set(["rich", "thin", "partial", "active"]));
  });
});

// `planDemoConversations` and its test are gone: the seed no longer plans
// conversations, so there is nothing to assert about how many it invents or
// which of them carries a switch. Role assignment over conversations the seed
// discovers is covered by `prisma/seed/plan.roles.test.ts` instead.

describe("demoInstanceNames", () => {
  it("never equals the live Evolution instance name", () => {
    for (const live of ["select-lub-poc", "select-lub-demo-connected"]) {
      for (const name of demoInstanceNames(live)) {
        expect(name).not.toBe(live);
      }
    }
  });
});

describe("isDemoSeedEnabled", () => {
  it("defaults on and treats 0/false as off", () => {
    expect(isDemoSeedEnabled({})).toBe(true);
    expect(isDemoSeedEnabled({ SEED_DEMO: "1" })).toBe(true);
    expect(isDemoSeedEnabled({ SEED_DEMO: "0" })).toBe(false);
    expect(isDemoSeedEnabled({ SEED_DEMO: "false" })).toBe(false);
  });

  it("skips TIDSCI when demo seed is off even if the dump flag is set", () => {
    expect(
      shouldFollowTidsciMockImport({ SEED_DEMO: "0", OMIE_MOCK_DATASET: "tidsci" }),
    ).toBe(false);
    expect(
      shouldFollowTidsciMockImport({ SEED_DEMO: "false", OMIE_MOCK_DATASET: "tidsci" }),
    ).toBe(false);
    expect(shouldFollowTidsciMockImport({ OMIE_MOCK_DATASET: "tidsci" })).toBe(true);
  });
});

describe("mockOmieSeedPlan", () => {
  it("uses the shared mock Omie identifiers and is stable across two reads", () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;

    const first = mockOmieSeedPlan();
    const second = mockOmieSeedPlan();
    const data = mockOmieDataset();

    expect(first).toEqual(second);
    expect(first.linked.omieId).toBe("omie-mock-linked");
    expect(first.matchable.omieId).toBe("omie-mock-matchable");
    expect(first.matchable.crmId).not.toBe(first.linked.crmId);
    expect(first.dupA.omieId).toBe("omie-mock-dup-a");
    expect(first.dupB.omieId).toBe("omie-mock-dup-b");
    expect(first.service.omieId).toBe("os-mock-1");
    expect(first.product.omieId).toBe("cat-motul-8100-5w30");
    expect(first.vehicle.vehicleOmieId).toBe("veh-omie-mock-1");
    expect(data.clients.map((row) => row.omieId).sort()).toEqual(
      ["omie-mock-dup-a", "omie-mock-dup-b", "omie-mock-linked", "omie-mock-matchable"].sort(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
  });

  it.each([
    ["a client", { clients: [] }],
    ["the service order", { serviceOrders: [] }],
    ["the catalog product", { products: [] }],
    ["the vehicle identifier", { vehicleIds: [] }],
  ])("refuses to plan a partial dataset when %s is missing", (_label, missing) => {
    // demo-seed requires the mock dataset to demonstrate EVERY mocked Omie
    // surface. Seeding five of the six rows would leave one screen silently
    // empty, which is harder to notice than a failed seed. The `||` chain that
    // enforces that had only its all-present outcome sampled.
    expect(() => mockOmieSeedPlan({ ...mockOmieDataset(), ...missing })).toThrow(
      /missing a required mock Omie identifier/,
    );
  });
});

describe("TIDSCI seed opt-in", () => {
  it("never names TIDSCI EMP0N units in the demo seed source", () => {
    const demo = readFileSync(join(import.meta.dirname, "../prisma/seed/demo.ts"), "utf8");
    expect(demo).not.toMatch(/TIDSCI EMP0[1-4]/);
  });
});

describe("DEMO_COVERED_MODELS vs DMMF", () => {
  it("lists every Prisma model so a new table fails until seeded", () => {
    const names = Prisma.dmmf.datamodel.models.map((model) => model.name).sort();
    expect([...DEMO_COVERED_MODELS].sort()).toEqual(names);
  });
});

/**
 * Added for the prefill 500.
 *
 * SUT: the literal the demo seed writes into `CadastroPrefillSuggestion.fields`.
 *
 * Oracle: `prefillFieldsSchema` — the response contract GET /conversations/:id/prefill
 * serializes through. Nothing else decides what that column may hold.
 *
 * Why this is a data test and not a route test. The #86 defect was a schema that refused
 * truthful data, so only a request through the server could see it. This is the mirror
 * case: the schema is right and the SEED is wrong. A route test would have to inject the
 * malformed shape by hand, and would then still fail after the seed is fixed — it would be
 * pinning the injected fixture, not the defect. What shipped broken is this literal, so
 * this literal is what gets held to the contract.
 *
 * Why it was invisible: Prisma types the column `Json`, so the call site is unchecked. The
 * seed compiled, ran, and wrote a row no reader could serialize.
 *
 * Axes
 *   A1 key legality — in `prefillFieldKeySchema` / not (`givenName`, `familyName`)
 *   A2 value shape — plain string / `{ value, confidence }` wrapper
 *
 * Sampled cells (one row per `it`)
 *   the seeded literal | A1,A2 | parses; THE case, and it failed on both axes at once
 *   no confidence key   | A2   | the contract has no such concept, so none may be invented
 */
describe("the demo prefill suggestion satisfies the response contract", () => {
  it("parses as prefill fields", () => {
    // Failed before the fix on every one of the four keys: `givenName` and `familyName` are
    // not in `prefillFieldKeySchema` and the object is `.strict()`; `plate` and `make` were
    // legal keys carrying an illegal `{ value, confidence }` value.
    expect(() => prefillFieldsSchema.parse(DEMO_PREFILL_PENDING_FIELDS)).not.toThrow();
  });

  it("carries plain values, with no confidence anywhere", () => {
    // Guards the tempting wrong fix: keeping the wrapper and widening the schema to accept
    // it would invent a concept the response contract does not have.
    for (const value of Object.values(DEMO_PREFILL_PENDING_FIELDS)) {
      expect(typeof value).toBe("string");
    }
  });
});
