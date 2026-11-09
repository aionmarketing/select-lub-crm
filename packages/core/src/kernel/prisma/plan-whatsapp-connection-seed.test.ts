/**
 * Test design (testing-strategy)
 *
 * Setup: planWhatsAppConnectionSeed is pure. No Prisma, no DATABASE_URL,
 * no Evolution, no WhatsApp.
 *
 * Oracle: hosted-evolution-channel whatsapp-channel
 * "Renaming the Evolution instance keeps the same WhatsApp connection"
 * (rename in place when one Baileys row exists; second run with the new
 * name does not create another row).
 *
 * Axes
 *   1. Env instance name already has a row — yes vs no
 *   2. EVOLUTION_BAILEYS count for the seeded unit — 0 / 1 / 2+
 *      BVA on count: 0 (edge), 1 (rename/create boundary), 2 (1+1)
 *
 * Outputs: O1 noop; O2 rename that id; O3 create
 *
 * Decision table (don't-cares collapsed after listing: when a row exists
 * for the env name, count is ignored)
 *   existing | count | action
 *   yes      | any   | noop
 *   no       | 1     | rename that id
 *   no       | 0     | create
 *   no       | 2+    | create
 *
 * Sampled-cell
 *   it                         | fails if
 *   env name already present   | action !== noop
 *   exactly one Baileys row    | action !== rename or id ≠ that row
 *   zero Baileys rows          | action !== create
 *   two Baileys rows           | action !== create
 *   second call after rename   | action !== noop (would create)
 *
 * Decisions
 *   D1 existingByName truthy     T: noop it; F: rename/create its
 *   D2 length === 1              T: rename it; F: create its (0 and 2+)
 *   D3 !existingBaileys throw    infeasible: findMany length === 1 always
 *      has [0]; no hollow case
 *
 * Out of scope: Prisma I/O in seed.ts; live db:seed; conversations FK
 * (id is preserved by rename, not re-asserted here).
 */
import { describe, expect, it } from "vitest";
import { planWhatsAppConnectionSeed } from "./plan-whatsapp-connection-seed.js";

const poc = { id: "conn-poc" };

describe("planWhatsAppConnectionSeed", () => {
  it.each([
    {
      name: "no-op when the env instance name already exists",
      existingByName: poc,
      baileysForUnit: [{ id: "other" }],
      expected: { action: "noop" as const },
    },
    {
      name: "renames the single Baileys row in place",
      existingByName: null,
      baileysForUnit: [poc],
      expected: { action: "rename" as const, id: "conn-poc" },
    },
    {
      name: "creates when no Baileys row exists",
      existingByName: null,
      baileysForUnit: [],
      expected: { action: "create" as const },
    },
    {
      name: "creates when two Baileys rows exist",
      existingByName: null,
      baileysForUnit: [{ id: "a" }, { id: "b" }],
      expected: { action: "create" as const },
    },
  ])("$name", ({ existingByName, baileysForUnit, expected }) => {
    expect(planWhatsAppConnectionSeed(existingByName, baileysForUnit)).toEqual(expected);
  });

  it("second call with the new name is a no-op and does not create", () => {
    const renamed = planWhatsAppConnectionSeed(null, [poc]);
    expect(renamed).toEqual({ action: "rename", id: "conn-poc" });

    expect(planWhatsAppConnectionSeed({ id: "conn-poc" }, [poc])).toEqual({ action: "noop" });
  });
});
