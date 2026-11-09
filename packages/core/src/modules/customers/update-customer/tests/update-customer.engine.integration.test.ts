/**
 * Test design (testing-strategy)
 *
 * Exercises the cadastro engine (`customers/contracts/cadastro-engine`) (`applyCrmEdit`,
 * `applyVehicleFieldEdit`, `getBusinessValue`, `ingestOmieSnapshot`) against the
 * real cadastro store, `createPrismaCadastroStore` in
 * `apps/api/src/cadastro/prisma.ts`. Relocated from
 * `packages/omie/src/engine.test.ts`: `packages/db` depends on `packages/omie`,
 * so the Prisma adapter cannot live in the Omie package (design D6).
 *
 * Moved from `apps/api/src/cadastro/omie/engine.test.ts`
 * (adopt-modular-vertical-slices 4B) and split by topic into the
 * `update-customer.engine*` files; the store is now `createCadastroStore`
 * (contracts/cadastro-store), which runs every call under `module_customers`.
 *
 * Setup: the real cadastro store on a rolled-back transaction + createFakeOmie().
 * The `getBusinessValue` suite is pure — it reads records, never a store — and
 * builds its records as literals rather than through any store at all.
 *
 * Fake-only assertions surfaced (three):
 *
 *  1. The CRM-only it wrote `mergedInto: "cus-base"`, naming a customer that was
 *     never created. `customer.merged_into_id` is a foreign key to `customer`, so
 *     the fake was asserting that a merge pointer can be set to nothing at all.
 *     A real base customer is now created and the pointer is checked against its
 *     id — which is what "merged into" has to mean.
 *
 *  2. Every phone assertion compared whole rows with `toEqual([{ raw, normalized,
 *     isPrimary }])`. Real `customer_phone` rows carry `updatedAt` as well, which
 *     the adapter maps into `PhoneRow`, so those comparisons described a row
 *     shape the adapter does not return. They now project the three fields under
 *     test explicitly.
 *
 *  3. The phone and e-mail its asserted on array ORDER, which the fake gave them
 *     for free by preserving insertion order in a JS array. `saveCustomer`
 *     deletes and re-creates the contact rows and reads them back through an
 *     unordered `findMany`, so Postgres guarantees no order at all — those
 *     assertions were true only by accident of the fake's data structure. They
 *     now sort by `normalized` before comparing, which is a property of the set
 *     of rows rather than of how the store happens to store them.
 *
 * `CARACTERISTICA_CAMPOS` is not part of the kernel's `erp-mock` barrel, so
 * this file declares the two labels it needs and pins them to the package's own
 * reader (`readSnapshotField`) in the first it.
 *
 * Oracle: openspec/changes/omie-field-conflict-sync/proposal.md and design.md
 * D4–D6 (decision table, pending freeze, CRM-only, conteudo string60).
 *
 * Techniques: decision table Axis 1 R1–R4 (no collapse); Axis 2 pending
 * dominant (P1/P2 sampled, P3 not); EP field kind; BVA length 59/60/61;
 * branch coverage of decideField (pending, CRM ahead, Omie ahead, both,
 * send fail, KM skip).
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * Axis 1 — pending closed; CRM ahead × Omie ahead
 *   R1 no/no no-op putCount 0 — sampled as R3 second pass + identical ingest
 *   R2 yes/no send — postalCode AND plate
 *   R3 no/yes apply OMIE_SYNC, localVersion unchanged — postalCode AND plate
 *   R4 yes/yes pending, neither business value changes — postalCode AND plate
 *
 * Axis 2 — open pending dominant
 *   P1 persist CRM, bump localVersion, do not send
 *   P2 bump externalVersion, do not apply Omie
 *
 * Axis 3 — CRM-only givenName/familyName/mergedIntoId never call adapter
 *   extra R2 primaryPhone creates isPrimary row
 *   extra D5 primaryPhone/primaryEmail promote existing normalized row
 *
 * Axis 4 — plate conteudo length 59 | 60 | 61
 *
 * Axis 5 — unparseable KM skip (no externalVersion bump); Vehicle.omieId
 *   stays null after plate R2
 *
 * Outputs: O-noop, O-send, O-apply-OMIE_SYNC, O-pending, O-freeze, O-fail-60
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                              | rule        | fails if
 * R1 identical ingest             | R1          | putCount > 0
 * R2 postalCode / plate           | R2          | Omie missing value or pending
 * R3 postalCode / plate + echo    | R3 then R1  | localVersion++ or 2nd put
 * R4 postalCode / plate           | R4          | CRM or Omie value flipped
 * P1 / P2                         | pending     | send or apply while open
 * CRM-only                        | Axis 3      | putCount > 0
 * primaryPhone creates row        | Axis 3      | no isPrimary phone
 * send promotes existing secondary| D5 found    | second row / two isPrimary
 * edit primary to secondary num   | D5 found    | primary row overwritten
 * send promotes existing email    | D5 found    | second email row
 * plate 59 / 60 / 61              | BVA         | 61 truncated or 60 not synced
 * KM skip                         | Axis 5      | externalVersion bumps
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map (engine.ts decideField + ingest skip)
 * ----------------------------------------------------------------------------
 * open pending? T P1/P2; F R1–R4
 * CRM ahead? T R2/R4/P1; F R1/R3/P2
 * Omie ahead? T R3/R4/P2; F R1/R2
 * both ahead? T R4; F R1–R3
 * toWire fail? T plate 61; F 59/60
 * KM read skip? T unparseable; F parseable R3 plate path (km dedicated it)
 *
 * getBusinessValue switch: every SHARED_FIELD_KEY sampled (person + vehicle;
 *   vehicle keys also sampled with vehicle=null → null).
 * applyVehicleFieldEdit: make/model/odometerKm (shared) and version/year
 *   (CRM-only columns). Object.hasOwn F: plate-null patch leaves make/year.
 *
 * Remaining one-sided (named, not faked): setBusinessValue `value === null`
 *   ternaries on person fields other than postalCode/name — ingest/edit
 *   fixtures already send non-null; the null arm is the same `?? null`
 *   clear already sampled on plate. decideField send-fail / KM skip stay
 *   on Axis 4/5.
 *
 * Out of scope: HTTP 404/409; resolve-pending; two vehicles (n-vehicles.test.ts);
 *   live Omie.
 *
 * Added 2026-09-07, per repo-foundation "Reachable production decisions have
 *   both test outcomes" — Axis 6 (unlinked customer; an omieId Omie does not
 *   recognise) and applyVehicleFieldEdit's omie_unavailable / no-shared-key
 *   branches, previously untested.
 *
 * Infeasible, named rather than left one-sided (added 2026-09-07):
 *   - decideField's `if (!owner) return` (person/vehicle mismatch) and
 *     applyCrmEdit's identical `if (!owner) continue` in the bumpLocal loop:
 *     both call sites of decideField already guarantee a titular vehicle
 *     exists before ever invoking it for a vehicle-shaped key — applyCrmEdit
 *     returns `not_found` earlier when `sharedKeys` names a vehicle field and
 *     `vehicle` is null (line 344), and ingestOmieSnapshot's own owner check
 *     runs before its call to decideField too. `syncOwner` returning null for
 *     a vehicle field with no vehicle can therefore never reach decideField's
 *     copy of the same check.
 *   - decideField's `!crmAhead && omieAhead` block (the omie-only branch,
 *     including its own `!snapshot` and `omieRead.status === "skip"` checks):
 *     unreachable from applyCrmEdit, because every key decideField is called
 *     for there was just `bumpLocal`-ed moments earlier in the same call,
 *     making it crmAhead by construction — the omie-only branch's condition
 *     is false on every applyCrmEdit-driven call. Reachable only from
 *     ingestOmieSnapshot, whose own top-level `if (!snapshot) return` and
 *     `if (read.status === "skip") continue` already filter exactly what
 *     decideField would otherwise re-check with the identical (snapshot,
 *     fieldKey) pair through the same pure `readSnapshotField` — so by the
 *     time ingestOmieSnapshot calls decideField, snapshot is already known
 *     non-null and non-skip, and decideField's own re-derivation cannot
 *     disagree. (The crmAhead-and-omieAhead branch's own `snapshot`/`skip`
 *     handling, lines 249/254, is the reachable sibling case covered by the
 *     Axis 6 pending-with-a-phantom-omieId it above — that branch IS driven
 *     from applyCrmEdit, where `snapshot` alone can be null.)
 *   - applyVehicleFieldEdit's bubbled `result.status !== "ok"` arm for
 *     not_found/unit_mismatch from its own nested applyCrmEdit call: the
 *     customer and unit were already validated moments earlier against the
 *     same ids; reaching a mismatch here needs the customer row to change
 *     mid-call, which nothing inside a single test transaction can do.
 *   - persistPrefillAccept's `!PREFILL_SHARED_KEYS.includes(...)` true arm:
 *     `PrefillFieldKey` (shared-types/prefill.ts) is the closed 8-value enum
 *     `{name, taxId, plate, make, model, version, year, odometerKm}`; the two
 *     CRM-only ones are handled above this line, and PREFILL_SHARED_KEYS is
 *     exactly the other six, so no value that survives Zod validation can
 *     miss it.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { applyCrmEdit, ingestOmieSnapshot } from "../../contracts/cadastro-engine/index.js";
import { createFakeOmie, emptySnapshot, readSnapshotField } from "../../../../kernel/clients/erp-mock.js";
import { emptySync, type FieldSyncRow } from "../../contracts/cadastro-store/port.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

/** Omie característica labels this file builds; pinned to the reader below. */
const CAMPOS = { plate: "Placa", odometerKm: "KM" } as const;

function synced(fieldKey: FieldSyncRow["fieldKey"], wire: string) {
  return {
    ...emptySync(fieldKey),
    lastAttemptedAt: null,
    localVersion: 1,
    externalVersion: 1,
    syncedLocalVersion: 1,
    syncedExternalVersion: 1,
    lastOmieWire: wire,
    origin: "CRM",
  };
}

/** The plate característica currently stored on the fake's snapshot. */
function plateConteudo(snapshot: { caracteristicas: { campo: string; conteudo: string }[] } | null) {
  return snapshot?.caracteristicas.find((row) => row.campo === CAMPOS.plate)?.conteudo;
}

/** A linked customer with one vehicle and three synced field rows. */
async function seedLinked(tx: DbClient) {
  const store = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
  const fake = createFakeOmie();
  const unit = await seedUnit(tx);
  const omieId = `omie-1-${randomUUID().slice(0, 8)}`;
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      postalCode: "01310100",
      country: "br",
      origin: "CRM",
      status: "active",
    },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, plate: "ABC1D23", omieId: null, origin: "CRM" },
  });
  fake.seed(omieId, {
    ...emptySnapshot(),
    razao_social: "Ana",
    cep: "01310100",
    codigo_pais: "1058",
    caracteristicas: [{ campo: CAMPOS.plate, conteudo: "ABC1D23" }],
  });
  await tx.customerFieldSync.createMany({
    data: [
      { customerId: customer.id, ...synced("name", "Ana") },
      { customerId: customer.id, ...synced("postalCode", "01310100") },
    ],
  });
  await tx.vehicleFieldSync.create({
    data: { vehicleId: vehicle.id, ...synced("plate", "ABC1D23") },
  });
  return { store, fake, unitId: unit.id, customerId: customer.id, vehicleId: vehicle.id, omieId };
}

describeWithDatabase("Axis 1 sync decision", () => {
  const db = () => prisma as PrismaClient;

  it("builds its caracteristica labels the way the package reads them", () => {
    const snapshot = {
      ...emptySnapshot(),
      caracteristicas: [
        { campo: CAMPOS.plate, conteudo: "ABC1D23" },
        { campo: CAMPOS.odometerKm, conteudo: "12000" },
      ],
    };

    const plate = readSnapshotField(snapshot, "plate");
    const km = readSnapshotField(snapshot, "odometerKm");

    expect(plate.status === "value" ? plate.wire : null).toBe("ABC1D23");
    expect(km.status === "value" ? km.wire : null).toBe("12000");
  });

  it("R1: identical snapshot is a no-op (adapter put count 0)", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId } = await seedLinked(tx);

      await ingestOmieSnapshot(store, fake, customerId);

      expect(fake.putCount()).toBe(0);
      const sync = await store.getSync({ customerId }, "name");
      expect(sync?.externalVersion).toBe(1);
    }));

  it("R2: CRM-only postalCode send updates Omie and synced*", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);

      const result = await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { postalCode: "22041080" },
      });

      expect(result.status).toBe("ok");
      expect(fake.putCount()).toBe(1);
      expect((await fake.get(omieId))?.cep).toBe("22041080");
      const sync = await store.getSync({ customerId }, "postalCode");
      expect(sync?.syncedLocalVersion).toBe(sync?.localVersion);
      expect(sync?.syncedExternalVersion).toBe(sync?.externalVersion);
      expect(await store.getOpenPending({ customerId }, "postalCode")).toBeNull();
    }));

  it("R2: CRM-only plate send updates Omie and leaves Vehicle.omieId null", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, unitId, customerId, omieId } = await seedLinked(tx);

      await applyCrmEdit(store, fake, {
        customerId,
        unitId,
        patch: { plate: "XYZ9A87" },
      });

      expect(plateConteudo(await fake.get(omieId))).toBe("XYZ9A87");
      expect((await store.getVehicleForCustomer(customerId))?.omieId).toBeNull();
    }));

  it("R3: Omie-only postalCode applies with OMIE_SYNC and second ingest does not put", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, omieId } = await seedLinked(tx);
      fake.seed(omieId, { ...(await fake.get(omieId))!, cep: "99999999" });
      const localBefore = (await store.getSync({ customerId }, "postalCode"))!.localVersion;

      await ingestOmieSnapshot(store, fake, customerId);
      const afterFirst = fake.putCount();
      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getCustomer(customerId))?.postalCode).toBe("99999999");
      const sync = await store.getSync({ customerId }, "postalCode");
      expect(sync?.origin).toBe("OMIE_SYNC");
      expect(sync?.localVersion).toBe(localBefore);
      expect(fake.putCount()).toBe(afterFirst);
      expect(fake.putCount()).toBe(0);
    }));

  it("R3: Omie-only plate applies without incrementing localVersion", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, vehicleId, omieId } = await seedLinked(tx);
      const snap = (await fake.get(omieId))!;
      snap.caracteristicas = [{ campo: CAMPOS.plate, conteudo: "OMIEPLATE" }];
      fake.seed(omieId, snap);
      const localBefore = (await store.getSync({ vehicleId }, "plate"))!.localVersion;

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getVehicleForCustomer(customerId))?.plate).toBe("OMIEPLATE");
      expect((await store.getSync({ vehicleId }, "plate"))?.localVersion).toBe(localBefore);
      expect(fake.putCount()).toBe(0);
    }));

  it("R4: dual-change postalCode opens pending and changes neither stored value", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, omieId } = await seedLinked(tx);
      const customer = (await store.getCustomer(customerId))!;
      await store.saveCustomer({ ...customer, postalCode: "CRMCEP12" });
      await tx.customerFieldSync.update({
        where: { customerId_fieldKey: { customerId, fieldKey: "postalCode" } },
        data: { localVersion: 2, syncedLocalVersion: 1 },
      });
      fake.seed(omieId, { ...(await fake.get(omieId))!, cep: "OMIECEP1" });

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getCustomer(customerId))?.postalCode).toBe("CRMCEP12");
      expect((await fake.get(omieId))?.cep).toBe("OMIECEP1");
      const pending = await store.getOpenPending({ customerId }, "postalCode");
      expect(pending?.status).toBe("open");
      expect(fake.putCount()).toBe(0);
    }));

  it("R4: dual-change plate opens pending and changes neither stored plate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, fake, customerId, vehicleId, omieId } = await seedLinked(tx);
      const vehicle = (await store.getVehicleForCustomer(customerId))!;
      await store.saveVehicle({ ...vehicle, plate: "CRMPLATE" });
      await tx.vehicleFieldSync.update({
        where: { vehicleId_fieldKey: { vehicleId, fieldKey: "plate" } },
        data: { localVersion: 2, syncedLocalVersion: 1 },
      });
      const snap = (await fake.get(omieId))!;
      snap.caracteristicas = [{ campo: CAMPOS.plate, conteudo: "OMIEPLATE" }];
      fake.seed(omieId, snap);

      await ingestOmieSnapshot(store, fake, customerId);

      expect((await store.getVehicleForCustomer(customerId))?.plate).toBe("CRMPLATE");
      expect(plateConteudo(await fake.get(omieId))).toBe("OMIEPLATE");
      expect((await store.getOpenPending({ vehicleId }, "plate"))?.status).toBe("open");
    }));
});
