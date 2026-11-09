/**
 * Idempotent demo dataset, written on top of conversations that already exist.
 *
 * The seed creates no `Conversation`, `WebhookEvent` or `OutboxMessage` rows.
 * Those arrive from the paired WhatsApp instance. It DOES write `Message` rows
 * with origin `SEED` — workshop pt-BR threads on the real phone numbers. Live
 * bodies stay until `db:scrub-live`.
 */
import type { PrismaClient } from "@prisma/client";
import { DEMO_CONNECTION_STATES, demoInstanceNames } from "./connections.js";
import { seedMockOmieDataset } from "./mock-omie.js";
import { createDb } from "../../src/kernel/db.js";
import { reconcileVehicleReturns } from "../../src/modules/services/contracts/reconcile-vehicle-returns.js";
import {
  assignConversationRoles,
  sortDecoratable,
  planDemoCustomers,
  sliceHasService,
  sliceHasVehicle,
  type ConversationRole,
} from "./plan.js";
import { isSeedableConversation, seedFakeHistory } from "./history.js";
import { planWorkshopSeedBatch } from "./workshop-threads.js";
import { writeThreadMixSummaryIfEnabled } from "./thread-mix-summary.js";
import { oilSourceFixtures } from "../../src/kernel/prisma/oil-source-fixtures.js";
import {
  tecfilCaptureFixtures,
  type TecfilCaptureFilter,
} from "../../src/kernel/prisma/tecfil-capture-fixtures.js";

const SCHEDULED_STATUSES = ["SCHEDULED", "SENT", "CANCELLED", "FAILED"] as const;
/** Origin classifications the seed fills in where ingest could not classify. */
const SOURCE_TYPES = ["AD", "ORGANIC", "UNKNOWN"] as const;

const DEMO_USERS = [
  { id: "a1111111-1111-4111-8111-111111111111", email: "demo.ana@selectlub.example", name: "Ana Souza" },
  { id: "b2222222-2222-4222-8222-222222222222", email: "demo.bruno@selectlub.example", name: "Bruno Lima" },
  { id: "c3333333-3333-4333-8333-333333333333", email: "demo.carla@selectlub.example", name: "Carla Mendes" },
] as const;

const TAGS = [
  { id: "demo-tag-retorno", name: "Retorno", color: "primary" },
  { id: "demo-tag-orcamento", name: "Orçamento", color: "secondary" },
  { id: "demo-tag-agendado", name: "Agendado", color: "info" },
] as const;

/**
 * Builds the seed's date helper, anchored to real data rather than the calendar.
 *
 * This used to resolve `Date.UTC(2026, 7, 31 - daysAgo, ...)` — every demo date
 * hung off a hardcoded 31 August 2026. That is why Relatórios rendered an empty
 * report at its default period: the seeded rows sat outside every recent window
 * and drifted further out with each passing day.
 *
 * Anchoring to the newest conversation fixes it permanently rather than moving
 * the constant. Real conversations are always current, so "N days before the
 * anchor" is always inside the periods the reports ask for, and nothing needs
 * maintaining. Anchoring to `Date.now()` instead was rejected in design.md: it
 * would place seeded rows at times unrelated to the conversations they belong
 * to, which reads wrong on any screen showing both.
 *
 * @param anchor - Newest real conversation's inbound time, or now when there are
 *   no conversations at all and nothing is being decorated anyway.
 * @returns `at(daysAgo, hour)` in America/Sao_Paulo terms, as before.
 */
function makeAt(anchor: Date) {
  return function at(daysAgo: number, hour = 12) {
    const day = new Date(anchor);
    day.setUTCDate(day.getUTCDate() - daysAgo);
    return new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour + 3, 0, 0),
    );
  };
}


/**
 * Deletes demo vehicles after removing their oil quotes.
 * OilQuote uses Restrict on vehicleId, so a leftover quote from an earlier mix blocks the delete.
 */
async function deleteDemoVehicles(
  prisma: PrismaClient,
  where: { customerId: string } | { id: string },
) {
  const rows = await prisma.vehicle.findMany({ where, select: { id: true } });
  const vehicleIds = rows.map((row) => row.id);
  if (vehicleIds.length === 0) {
    return;
  }
  await prisma.oilQuote.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.vehicle.deleteMany({ where });
}

/**
 * One write the CRM owed the ERP, already delivered (`sent`), for a demo customer.
 * Terminal on purpose; see the call site.
 *
 * @param prisma - The seed's client.
 * @param customer - A rich demo customer: it carries an Omie id, so it has a
 *   record in the ERP to write to.
 */
async function seedErpOutboxRow(prisma: PrismaClient, customer: { id: string; name: string }) {
  const erpOutboxRow = {
    entity: "customer",
    entityId: customer.id,
    operation: "put",
    erpRecordId: `omie-demo-${customer.id}`,
    integrationCode: customer.id,
    fields: { name: customer.name },
    versions: { name: { localVersion: 2, externalVersion: 1 } },
    status: "sent",
    attemptCount: 1,
    nextAttemptAt: new Date("2026-09-01T12:00:00.000Z"),
    claimedAt: null,
    sentAt: new Date("2026-09-01T12:00:04.000Z"),
    lastError: null,
    idempotencyKey: "demo-erp-outbox-1",
  };
  await prisma.erpOutbox.upsert({
    where: { id: "demo-erp-outbox-1" },
    create: { id: "demo-erp-outbox-1", ...erpOutboxRow },
    update: erpOutboxRow,
  });
}

/**
 * Writes the demo dataset for one pair of units. Safe to re-run (upsert / findFirst).
 *
 * Does not create `TIDSCI EMP0N` units. TIDSCI-derived clients land on `Select Lub`
 * through the worker mock pull when `OMIE_MOCK_DATASET=tidsci`.
 *
 * @param prisma - Shared Prisma client.
 * @param input.unitId - Primary loja (Select Lub).
 * @param input.unitBId - Second loja.
 * @param input.liveInstanceName - Live Evolution instance; demo names never equal this.
 */
/**
 * Maps one captured Tecfil filter onto the shape the compatibility cache stores.
 *
 * @param filter - A filter as the capture recorded it.
 * @returns The cached filter, cross-references included so the chooser has two candidates.
 */
function toCachedFilter(filter: TecfilCaptureFilter) {
  return {
    tecfilNumber: filter.partNumber,
    tecfilProductCode: filter.productCode,
    description: filter.description,
    crossReferences: filter.crossReferences.map((reference) => ({
      brand: reference.brand,
      number: reference.partNumber,
    })),
  };
}

export async function seedDemoDataset(
  prisma: PrismaClient,
  input: { unitId: string; unitBId: string; liveInstanceName: string },
) {
  const instanceNames = demoInstanceNames(input.liveInstanceName);

  for (const user of DEMO_USERS) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: user,
      update: { email: user.email, name: user.name },
    });
    await prisma.userUnit.upsert({
      where: { userId_unitId: { userId: user.id, unitId: input.unitId } },
      create: { userId: user.id, unitId: input.unitId },
      update: {},
    });
  }

  const connections = [];
  for (const [index, instanceName] of instanceNames.entries()) {
    const row = await prisma.whatsAppConnection.upsert({
      where: { instanceName },
      create: {
        id: `demo-wa-${DEMO_CONNECTION_STATES[index]}`,
        instanceName,
        unitId: input.unitId,
        provider: "EVOLUTION_BAILEYS",
        connectionState: DEMO_CONNECTION_STATES[index],
      },
      update: { connectionState: DEMO_CONNECTION_STATES[index] },
    });
    connections.push(row);
  }
  // The demo connections exist only so every connectionState is demonstrable.
  // Nothing hangs off them: conversations arrive from the live instance, and a
  // demo connection carrying one would put fabricated rows into every report,
  // because report queries scope by the connection's unit and these share it.

  // Plan identities first so thread bodies can mention the same ficha (or a
  // distractor that disagrees with it). Role assignment waits until after the
  // `SEED` timestamps exist — quote needs `firstOutboundAt` from the fake thread.
  const originalDecoratable = sortDecoratable(
    await prisma.conversation.findMany({
      where: { whatsappConnection: { unitId: input.unitId } },
      select: {
        id: true,
        chatKey: true,
        firstInboundAt: true,
        firstOutboundAt: true,
        startedAt: true,
        remoteJid: true,
        whatsappConnection: { select: { instanceName: true } },
      },
    }),
  );
  const customers = planDemoCustomers(originalDecoratable.length);
  const customerByConversationId = new Map(
    originalDecoratable.map((row, index) => [row.id, customers[index]!]),
  );
  const customerIndexByConversationId = new Map(
    originalDecoratable.map((row, index) => [row.id, index]),
  );
  const demoNames = new Set(instanceNames);
  const seedable = originalDecoratable
    .filter((row) => isSeedableConversation(row, demoNames))
    .map((row) => ({
      id: row.id,
      chatKey: row.chatKey,
      firstInboundAt: row.firstInboundAt,
      firstOutboundAt: row.firstOutboundAt,
      startedAt: row.startedAt,
      hasVehicle: sliceHasVehicle(customerByConversationId.get(row.id)?.slice ?? "thin"),
    }));
  const workshop = planWorkshopSeedBatch({
    conversations: seedable,
    customerByConversationId,
    customerIndexByConversationId,
  });
  for (const { archetype, reason } of workshop.assignment.unfilled) {
    console.warn(`seed: no conversation could carry the "${archetype}" thread — ${reason}`);
  }

  await seedFakeHistory(prisma, {
    unitId: input.unitId,
    liveInstanceName: input.liveInstanceName,
    planThread: (plan) => workshop.plannedByConversation.get(plan.conversationId) ?? [],
  });
  await writeThreadMixSummaryIfEnabled(true, {
    unfilled: workshop.assignment.unfilled,
    threads: workshop.summaryThreads,
  });

  // Reload after `SEED` timestamps: quote reads `firstOutboundAt` from the fake
  // exchange, not leftover LIVE rows. Cadastro pairing stays on `originalDecoratable`
  // so identity i still belongs to the same conversation id.
  const decoratable = sortDecoratable(
    await prisma.conversation.findMany({
      where: { whatsappConnection: { unitId: input.unitId } },
      select: { id: true, chatKey: true, firstInboundAt: true, firstOutboundAt: true },
    }),
  );
  // Newest conversation anchors every seeded date. `decoratable` is sorted
  // oldest-first, so the last entry is the most recent; `now` only when there is
  // nothing to decorate, in which case no dated demo row matters anyway.
  const at = makeAt(decoratable.at(-1)?.firstInboundAt ?? new Date());

  const roles = assignConversationRoles(decoratable);
  for (const { role, reason } of roles.unfilled) {
    // Reported rather than fatal: a database whose conversations are merely
    // quiet is a legitimate one to seed, and the operator should know which demo
    // surface will be empty instead of wondering whether the seed broke.
    console.warn(`seed: no conversation could carry the "${role}" role — ${reason}`);
  }
  const roleConversation = (role: ConversationRole) => roles.byRole.get(role);
  // Each may be undefined: the batch can be too small, or no conversation can
  // satisfy a role's data constraint. Every block below is guarded, so a demo
  // surface goes missing rather than the seed failing or writing a dangling row.
  const quoteConversationId = roleConversation("quote");
  const tagRemovedConversationId = roleConversation("tagRemoved");
  const prefillPendingConversationId = roleConversation("prefillPending");
  const prefillFailedConversationId = roleConversation("prefillFailed");

  // Identities were planned once, before threads, and paired by conversation id
  // on the original sort. Re-planning here would reset faker after distractors
  // had already consumed it; re-indexing after `SEED` timestamps could swap
  // which ficha sits on which chat.
  /** Which conversation each identity decorates, for dating its rows against it. */
  const conversationOf = new Map(
    customers.map((row, index) => [row.id, originalDecoratable[index]!]),
  );

  for (const [index, planned] of customers.entries()) {
    const conversation = originalDecoratable[index]!;
    // The last identity goes to the second unit, so unit scoping stays
    // demonstrable at any volume. It was index 19 of a fixed 20 before.
    const unitId = index === customers.length - 1 ? input.unitBId : input.unitId;
    const rich = planned.slice === "rich";
    await prisma.customer.upsert({
      where: { id: planned.id },
      create: {
        id: planned.id,
        name: planned.name,
        givenName: planned.name.split(" ")[0],
        familyName: planned.name.split(" ").slice(1).join(" "),
        unitId,
        origin: rich ? "omie" : "crm",
        status: "active",
        city: rich ? "Campinas" : null,
        state: rich ? "SP" : null,
        country: rich ? "BR" : null,
        postalCode: rich ? "13010-000" : null,
        street: rich ? "Rua Conceição" : null,
        streetNumber: rich ? String(100 + index) : null,
        neighborhood: rich ? "Centro" : null,
        taxId: rich ? planned.taxId : null,
        omieId: rich ? `omie-demo-${planned.id}` : null,
      },
      update: {
        name: planned.name,
        unitId,
        origin: rich ? "omie" : "crm",
        city: rich ? "Campinas" : null,
        state: rich ? "SP" : null,
        country: rich ? "BR" : null,
        postalCode: rich ? "13010-000" : null,
        street: rich ? "Rua Conceição" : null,
        streetNumber: rich ? String(100 + index) : null,
        neighborhood: rich ? "Centro" : null,
        taxId: rich ? planned.taxId : null,
        omieId: rich ? `omie-demo-${planned.id}` : null,
      },
    });
    await prisma.customerPhone.deleteMany({
      where: { customerId: planned.id, NOT: { id: `${planned.id}-phone` } },
    });
    // The one field here that is NOT invented. `chatKey` is the conversation's
    // normalized number, so the customer and the thread agree — which is also
    // what makes the customer findable by the number an attendant can see on
    // screen, since search matches a query against both.
    await prisma.customerPhone.upsert({
      where: { id: `${planned.id}-phone` },
      create: {
        id: `${planned.id}-phone`,
        customerId: planned.id,
        raw: conversation.chatKey,
        normalized: conversation.chatKey,
        isPrimary: true,
      },
      update: { raw: conversation.chatKey, normalized: conversation.chatKey, isPrimary: true },
    });
    // Attach the identity to the conversation it was generated for. Scoped by
    // `customerId: null` so a conversation someone else has already linked is
    // never taken over, even if the batch was computed before they did it.
    await prisma.conversation.updateMany({
      where: { id: conversation.id, customerId: null },
      data: { customerId: planned.id },
    });

    // Origin classification, so `Conversão por origem` has all three values to
    // report. This is metadata ABOUT the conversation, not a fact of the
    // exchange, which is why the seed may write it at all.
    //
    // Scoped to rows still `UNKNOWN`. Ingest sets `sourceType` and `ctwaClid`
    // from real click-to-WhatsApp evidence, so overwriting a classification it
    // made would destroy a true fact about where that customer came from — the
    // same mistake as overwriting a customer someone attached by hand.
    const sourceType = SOURCE_TYPES[index % SOURCE_TYPES.length]!;
    await prisma.conversation.updateMany({
      where: { id: conversation.id, sourceType: "UNKNOWN" },
      data:
        sourceType === "AD"
          ? {
              sourceType,
              ctwaClid: `demo-clid-${index}`,
              campaignId: "camp-demo",
              adSetId: "set-demo",
              adId: `ad-${index}`,
            }
          : { sourceType },
    });

    if (planned.email) {
      await prisma.customerEmail.deleteMany({
        where: { customerId: planned.id, NOT: { id: `${planned.id}-email` } },
      });
      await prisma.customerEmail.upsert({
        where: { id: `${planned.id}-email` },
        create: {
          id: `${planned.id}-email`,
          customerId: planned.id,
          raw: planned.email,
          normalized: planned.email,
          isPrimary: true,
        },
        update: { raw: planned.email, normalized: planned.email, isPrimary: true },
      });
    } else {
      await prisma.customerEmail.deleteMany({ where: { customerId: planned.id } });
    }
    if (sliceHasVehicle(planned.slice)) {
      const vehicleId = `${planned.id}-veh`;
      await prisma.vehicle.upsert({
        where: { id: vehicleId },
        create: {
          id: vehicleId,
          customerId: planned.id,
          plate: planned.plate,
          make: "Volkswagen",
          model: "Polo",
          // The four-field identity is what makes a quote possible at all, and it must be
          // one the committed fixture actually covers (fixtures/oil-sources.json).
          version: "1.0 TSI",
          year: 2018 + (index % 6),
          origin: rich ? "omie" : "crm",
          omieId: rich ? `omie-veh-${vehicleId}` : null,
        },
        // `version` is in the update too, not only the create: a demo database seeded
        // before the identity rule would otherwise keep its null version forever and stay
        // permanently unquotable.
        update: { plate: planned.plate, customerId: planned.id, version: "1.0 TSI" },
      });
    } else {
      await deleteDemoVehicles(prisma, { customerId: planned.id });
    }
    if (rich) {
      await prisma.vehicle.upsert({
        where: { id: `${planned.id}-veh-2` },
        create: {
          id: `${planned.id}-veh-2`,
          customerId: planned.id,
          plate: null,
          make: "Fiat",
          model: "Argo",
          version: "1.0 Firefly",
          year: 2021,
          origin: "crm",
        },
        update: { version: "1.0 Firefly" },
      });
    } else {
      await deleteDemoVehicles(prisma, { id: `${planned.id}-veh-2` });
    }
  }

  // These rows demonstrate merge, field-sync and reconciliation states, and they
  // address customers by position (01-06 and 20). Identity count now follows the
  // conversations, so on a small batch those positions do not exist and the
  // updates below would fail on a record that was never planned. Skipped whole
  // rather than guarded one by one: they are a single coherent demonstration,
  // and half of it is not worth having.
  if (customers.length >= 20) {
    // Addressed by SLICE, not by index. The mix is proportional now, so which
    // position is rich or carries a vehicle depends on the batch size — the old
    // hardcoded ids assumed the fixed 20-row layout and broke the moment it moved.
    // Inside the guard because on an empty batch there is no rich customer to find.
    const richCustomerId = customers.find((row) => row.slice === "rich")!.id;
    const mergedCustomerId = customers[customers.length - 1]!.id;
    const withVehicle = customers.filter((row) => sliceHasVehicle(row.slice));
    const vehicleOwnerA = withVehicle[0]!.id;
    const vehicleOwnerB = withVehicle[1]!.id;
    await prisma.customer.update({
      where: { id: mergedCustomerId },
      data: { mergedIntoId: richCustomerId },
    });

    await prisma.customerFieldSync.upsert({
      where: { customerId_fieldKey: { customerId: richCustomerId, fieldKey: "name" } },
      create: {
        customerId: richCustomerId,
        fieldKey: "name",
        origin: "crm",
        lastResult: "ok",
      },
      update: {},
    });
    await prisma.vehicleFieldSync.upsert({
      where: { vehicleId_fieldKey: { vehicleId: `${richCustomerId}-veh`, fieldKey: "plate" } },
      create: {
        vehicleId: `${richCustomerId}-veh`,
        fieldKey: "plate",
        origin: "omie",
        lastResult: "ok",
      },
      update: {},
    });
    // The cache's vocabulary is `resolved` / `miss`, the only two values the
    // production writer stores. (`found` is the billing ledger's word, below.)
    // Set on update too, so a database seeded before this fix corrects itself.
    await prisma.plateLookup.upsert({
      where: { plate: "ABC1D23" },
      create: {
        plate: "ABC1D23",
        outcome: "resolved",
        provider: "mock",
        fields: { make: "VW", model: "GOL", version: "1.0", year: 2021 },
        rawPayload: { source: "demo-seed" },
        lookedUpAt: at(2),
      },
      update: { outcome: "resolved" },
    });
    await prisma.plateLookupCall.upsert({
      where: { id: "demo-plate-lookup-call-1" },
      create: {
        id: "demo-plate-lookup-call-1",
        plate: "ABC1D23",
        provider: "mock",
        outcome: "found",
        unitId: input.unitId,
        billedAt: at(2),
      },
      update: {},
    });
    await prisma.customerReconciliationPending.upsert({
      where: { id: "demo-pend-cus-open" },
      create: {
        id: "demo-pend-cus-open",
        customerId: customers[1]!.id,
        fieldKey: "taxId",
        crmValue: "111",
        omieValue: "222",
        localVersion: 1,
        externalVersion: 2,
        status: "open",
      },
      update: {},
    });
    await prisma.customerReconciliationPending.upsert({
      where: { id: "demo-pend-cus-resolved" },
      create: {
        id: "demo-pend-cus-resolved",
        customerId: customers[2]!.id,
        fieldKey: "name",
        crmValue: "A",
        omieValue: "B",
        localVersion: 1,
        externalVersion: 1,
        status: "resolved",
        reason: "kept_local",
      },
      update: {},
    });
    await prisma.vehicleReconciliationPending.upsert({
      where: { id: "demo-pend-veh-open" },
      create: {
        id: "demo-pend-veh-open",
        vehicleId: `${vehicleOwnerA}-veh`,
        fieldKey: "plate",
        crmValue: "AAA1A11",
        omieValue: "BBB2B22",
        localVersion: 1,
        externalVersion: 2,
        status: "open",
      },
      update: { vehicleId: `${vehicleOwnerA}-veh` },
    });
    await prisma.vehicleReconciliationPending.upsert({
      where: { id: "demo-pend-veh-resolved" },
      create: {
        id: "demo-pend-veh-resolved",
        vehicleId: `${vehicleOwnerB}-veh`,
        fieldKey: "year",
        crmValue: "2018",
        omieValue: "2019",
        localVersion: 1,
        externalVersion: 1,
        status: "resolved",
        reason: "kept_external",
      },
      update: { vehicleId: `${vehicleOwnerB}-veh` },
    });

  }
  for (const tag of TAGS) {
    await prisma.tag.upsert({
      where: { id: tag.id },
      create: { ...tag, unitId: input.unitId, sortOrder: 0, active: true },
      update: { name: tag.name, color: tag.color },
    });
  }
  await prisma.template.upsert({
    where: { id: "demo-tpl-active" },
    create: {
      id: "demo-tpl-active",
      unitId: input.unitId,
      name: "Retorno troca de óleo",
      text: "Olá {{nome_cliente}}, seu {{placa}} já pode retornar.",
      allowedVariables: ["nome_cliente", "placa"],
      status: "active",
    },
    update: {},
  });
  await prisma.template.upsert({
    where: { id: "demo-tpl-inactive" },
    create: {
      id: "demo-tpl-inactive",
      unitId: input.unitId,
      name: "Arquivado",
      text: "Olá {{nome_cliente}}.",
      allowedVariables: ["nome_cliente"],
      status: "inactive",
    },
    update: {},
  });


  if (quoteConversationId) {
    await prisma.conversationTag.upsert({
      where: { id: "demo-ctag-active" },
      create: {
        id: "demo-ctag-active",
        conversationId: quoteConversationId,
        tagId: "demo-tag-retorno",
        assignedAt: at(5),
      },
      update: {},
    });
  }
  if (tagRemovedConversationId) {
    await prisma.conversationTag.upsert({
      where: { id: "demo-ctag-removed" },
      create: {
        id: "demo-ctag-removed",
        conversationId: tagRemovedConversationId,
        tagId: "demo-tag-orcamento",
        assignedAt: at(15),
        removedAt: at(8),
      },
      update: {},
    });
  }

  if (prefillPendingConversationId) {
    // Ids derived from the conversation, not fixed strings. The seed takes a
    // unitId and may legitimately run for two units in one database — an API
    // suite does exactly that to seed only its own unit. With fixed ids the job
    // upsert (keyed by id) found the first unit's row and no-opped, while the
    // suggestion upsert (keyed by conversationId) found nothing and tried to
    // create `demo-prefill-sug` a second time, failing on a unique id. The two
    // upserts disagreed about what identifies the row; deriving both from the
    // conversation makes them agree, and keeps a suggestion pointing at the job
    // for its own conversation rather than another unit's.
    const prefillPendingJobId = `demo-prefill-pending-${prefillPendingConversationId}`;
    await prisma.cadastroPrefillJob.upsert({
      where: { id: prefillPendingJobId },
      create: {
        id: prefillPendingJobId,
        conversationId: prefillPendingConversationId,
        status: "pending",
      },
      update: {},
    });
    await prisma.cadastroPrefillSuggestion.upsert({
      where: { conversationId: prefillPendingConversationId },
      create: {
        id: `demo-prefill-sug-${prefillPendingConversationId}`,
        conversationId: prefillPendingConversationId,
        jobId: prefillPendingJobId,
        extractedAt: at(2),
        fields: DEMO_PREFILL_PENDING_FIELDS,
      },
      update: {},
    });
  }
  if (prefillFailedConversationId) {
    // Derived for the same reason as the pending job above: a second unit in the
    // same database must get its own row rather than silently reusing the first
    // unit's, which the fixed id made it do.
    const prefillFailedJobId = `demo-prefill-failed-${prefillFailedConversationId}`;
    await prisma.cadastroPrefillJob.upsert({
      where: { id: prefillFailedJobId },
      create: {
        id: prefillFailedJobId,
        conversationId: prefillFailedConversationId,
        status: "failed",
        lastError: "timeout",
      },
      update: {},
    });
  }

  await prisma.intervalRule.upsert({
    where: { id: "demo-interval-oil" },
    create: {
      id: "demo-interval-oil",
      version: 1,
      criterion: "kind",
      criterionId: "oil",
      intervalAmount: 6,
      intervalUnit: "months",
      priority: 1,
      active: true,
    },
    update: {},
  });

  const serviceOwners = customers.filter((row) => sliceHasService(row.slice));
  for (const [i, customer] of serviceOwners.entries()) {
    // Every demo service is Omie-origin: the product has no path that creates
    // one in the CRM, and a crm-origin row carries no completion signal, so it
    // would sit invisible to REP-11/REP-12 with nothing on screen explaining
    // the gap (OpenSpec services-are-omie-origin-only).
    // Dated against the customer's OWN conversation, not a global anchor: a
    // service is the thing the conversation is about, so it has to precede it.
    // The spread (1-4 days for the first few, then months back) is what gives
    // Relatórios non-trivial buckets and what opens overdue vehicle returns.
    const ownConversation = conversationOf.get(customer.id);
    const daysBefore = i < 4 ? i + 1 : 30 + i * 20;
    const performedAt = ownConversation?.firstInboundAt
      ? new Date(ownConversation.firstInboundAt.getTime() - daysBefore * 86_400_000)
      : at(daysBefore);
    await prisma.service.upsert({
      where: { id: `demo-svc-${i + 1}` },
      create: {
        id: `demo-svc-${i + 1}`,
        customerId: customer.id,
        vehicleId: `${customer.id}-veh`,
        unitId: input.unitId,
        omieId: `omie-os-demo-${i + 1}`,
        performedAt,
        description: "Troca de óleo",
        kind: "oil",
        status: "done",
        amount: 180 + i * 15,
        origin: "omie",
      },
      // Rewrite owner, origin and omieId too, so a re-seed over an existing
      // database corrects rows created before the workshop-mix change.
      update: {
        customerId: customer.id,
        vehicleId: `${customer.id}-veh`,
        performedAt,
        amount: 180 + i * 15,
        omieId: `omie-os-demo-${i + 1}`,
        origin: "omie",
      },
    });
    await prisma.serviceItem.upsert({
      where: { id: `demo-svc-${i + 1}-item` },
      create: {
        id: `demo-svc-${i + 1}-item`,
        serviceId: `demo-svc-${i + 1}`,
        description: "Óleo 5W-30",
        kind: "oil",
        quantity: 4,
        unitAmount: 45,
        lineAmount: 180,
        oilViscosity: "5W-30",
        oilBrand: "Motul",
      },
      update: {},
    });
  }
  const keepServiceIds = serviceOwners.map((_, index) => `demo-svc-${index + 1}`);
  await prisma.service.deleteMany({
    where: { id: { startsWith: "demo-svc-" }, NOT: { id: { in: keepServiceIds } } },
  });

  for (const [index, status] of SCHEDULED_STATUSES.entries()) {
    // Every scheduled message needs a customer and a service to hang off, and
    // there may be neither: this loop iterates the four statuses, not the owner
    // list, so it used to index past the end whenever fewer than four customers
    // exist. That is the zero-conversation case, which became reachable when
    // identity count started following the conversations.
    const owner = serviceOwners[index];
    if (!owner) {
      continue;
    }
    // `conversationId` is optional on this model. There is no longer a
    // conversation per seeded customer to derive one from, so all four hang off
    // the quote conversation — already known to have a reply, which makes a
    // scheduled message on it coherent — and off none at all when that role went
    // unfilled. Each carries its own `serviceId`, so one conversation holding
    // four does not violate the one-schedule-per-service rule.
    const conversationId = quoteConversationId ?? null;
    await prisma.scheduledMessage.upsert({
      where: { idempotencyKey: `demo-sched-${status}` },
      create: {
        id: `demo-sched-${status}`,
        customerId: owner.id,
        conversationId,
        serviceId: `demo-svc-${index + 1}`,
        templateId: "demo-tpl-active",
        frozenText: "Olá, retorno da troca de óleo.",
        suggestedAt: at(2),
        suggestionSource: index === 0 ? "six_months" : "rule",
        intervalRuleId: index === 0 ? null : "demo-interval-oil",
        intervalRuleVersion: index === 0 ? null : 1,
        scheduledAt: at(-index, 14),
        status,
        idempotencyKey: `demo-sched-${status}`,
        createdByUserId: DEMO_USERS[0]!.id,
        sentAt: status === "SENT" ? at(1) : null,
        cancelledAt: status === "CANCELLED" ? at(1) : null,
        lastError: status === "FAILED" ? "demo fail" : null,
      },
      update: { customerId: owner.id, conversationId, serviceId: `demo-svc-${index + 1}` },
    });
  }

  await prisma.syncExecution.upsert({
    where: { id: "demo-sync-1" },
    create: {
      id: "demo-sync-1",
      source: "omie",
      entity: "customers",
      mode: "incremental",
      status: "succeeded",
    },
    update: {},
  });
  await prisma.integrationError.upsert({
    where: { id: "demo-ierr-1" },
    create: {
      id: "demo-ierr-1",
      integration: "omie",
      operation: "list_customers",
      code: "timeout",
      message: "Omie mock timeout",
      retryable: true,
    },
    update: {},
  });

  // One write the CRM owed the ERP, already delivered. TERMINAL on purpose, never
  // `pending` or `sending`: erp/drain-outbox claims due rows database-wide, and CI's
  // database is seeded, so a claimable demo row would be picked up by the drain
  // tests mid-suite. Every field is on `update` too, so a re-seed over an older row
  // restores it rather than leaving it half-written. A unit with no conversations
  // plans no customers, and then there is no write to have owed: no row.
  const erpCustomer = customers.find((row) => row.slice === "rich");
  if (erpCustomer) {
    await seedErpOutboxRow(prisma, erpCustomer);
  }

  // Filter fitment comes from the committed Tecfil capture, never from a number typed by
  // hand: a wrong part number on a quote is a wrong part fitted to a customer's car.
  const tecfilIds: string[] = [];
  for (const capture of tecfilCaptureFixtures()) {
    const id = `demo-tecfil-${capture.make}-${capture.model}-${capture.year}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    tecfilIds.push(id);
    await prisma.tecfilCompatibility.upsert({
      where: { id },
      create: {
        id,
        make: capture.make,
        year: Number(capture.year),
        model: capture.model,
        version: capture.version,
        manufacturerLabel: capture.make.toUpperCase(),
        vehicleLabel: capture.model.toUpperCase(),
        engineLabel: capture.tecfilEngine ?? null,
        matchedBy: capture.fitment!.matchedBy as object,
        oilFilters: capture.fitment!.oilFilters.map(toCachedFilter),
        fuelFilters: capture.fitment!.fuelFilters.map(toCachedFilter),
        consultedAt: at(12),
      },
      update: {},
    });
  }

  // One verified-spec row per committed ingested source. Reading the fixture is the whole
  // point: the seed must not call Motul, Tecfil or OpenAI, and must not invent a spec
  // that no cited document supports.
  const specIds: string[] = [];
  for (const fixture of oilSourceFixtures()) {
    const id = `demo-oil-spec-${fixture.make}-${fixture.model}-${fixture.year}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    specIds.push(id);
    await prisma.motulCompatibility.upsert({
      where: { id },
      create: {
        id,
        make: fixture.make,
        year: fixture.year,
        model: fixture.model,
        version: fixture.version,
        viscosities: fixture.viscosityGrades,
        viscosity: fixture.viscosityGrades[0]!,
        classification: fixture.classification,
        fillLiters: fixture.fillLiters,
        fillKind: fixture.fillKind,
        sourcePublisher: fixture.publisher,
        sourceDocument: fixture.document,
        sourcePage: fixture.page,
        sourceAuthority: fixture.authority,
        sourceUrl: fixture.url,
        consultedAt: at(12),
      },
      update: {},
    });
  }

  // Upsert never deletes, so a demo row the fixtures no longer describe would linger with
  // an identity no seeded vehicle shares — which is exactly the "cache row for a car that
  // does not exist" state the demo-seed spec forbids. Scoped to the seed's own `demo-` ids
  // plus the two fixed ids earlier seeds wrote by hand; a real workshop's rows are never
  // touched.
  await prisma.motulCompatibility.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "demo-oil-spec-" }, NOT: { id: { in: specIds } } },
        { id: "demo-motul-polo" },
      ],
    },
  });
  await prisma.tecfilCompatibility.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "demo-tecfil-" }, NOT: { id: { in: tecfilIds } } },
        { id: "demo-tecfil-polo" },
      ],
    },
  });

  const catalog = await prisma.catalogItem.findFirst({ where: { id: "cat-motul-8100-5w30" } });
  // No quote at all when no conversation could carry one. `demo-seed` forbids a
  // quote on a conversation recording no reply — sending a quote IS an outbound
  // message — and the seed may not write `firstOutboundAt`, so an unfilled quote
  // role means the real data cannot support this surface.
  if (catalog && quoteConversationId) {
    await prisma.oilQuote.upsert({
      where: { id: "demo-quote-1" },
      create: {
        id: "demo-quote-1",
        customerId: customers.find((row) => row.slice === "rich")!.id,
        vehicleId: `${customers.find((row) => row.slice === "rich")!.id}-veh`,
        conversationId: quoteConversationId,
        generatedMessageText: "Orçamento de troca de óleo",
        createdByUserId: DEMO_USERS[0]!.id,
        createdAt: at(6),
      },
      update: { conversationId: quoteConversationId },
    });
    await prisma.oilQuoteLine.upsert({
      where: { id: "demo-quote-1-line" },
      create: {
        id: "demo-quote-1-line",
        oilQuoteId: "demo-quote-1",
        catalogItemId: catalog.id,
        brand: catalog.brand,
        description: catalog.description,
        price: catalog.price,
      },
      update: {},
    });
  }

  await prisma.attributionRule.upsert({
    where: { version: 1 },
    create: { id: "attribution-rule-v1", version: 1, windowDays: 30 },
    update: {},
  });
  // Both ends must exist: demo-svc-1 comes from the service loop and
  // demo-sched-SENT from the scheduled loop, and neither runs without customers.
  if (serviceOwners.length > 0) {
    await prisma.serviceScheduledAttribution.upsert({
      where: { serviceId_scheduledMessageId: { serviceId: "demo-svc-1", scheduledMessageId: "demo-sched-SENT" } },
      create: { serviceId: "demo-svc-1", scheduledMessageId: "demo-sched-SENT", ruleVersion: 1 },
      update: {},
    });
  }
  // Attribution links a service to the conversation it came from. It hangs off
  // the tagRemoved role's conversation only because that role is unconstrained
  // and therefore the most likely to be filled — any decorated conversation
  // would do, and none at all is a legitimate outcome on a small batch.
  if (tagRemovedConversationId && serviceOwners.length > 1) {
    await prisma.serviceConversationAttribution.deleteMany({
      where: { serviceId: "demo-svc-2", NOT: { conversationId: tagRemovedConversationId } },
    });
    await prisma.serviceConversationAttribution.upsert({
      where: {
        serviceId_conversationId: {
          serviceId: "demo-svc-2",
          conversationId: tagRemovedConversationId,
        },
      },
      create: { serviceId: "demo-svc-2", conversationId: tagRemovedConversationId, ruleVersion: 1 },
      update: {},
    });
  }
  // Guarded on the quote conversation too, not only the catalog: this row has a
  // foreign key to `demo-quote-1`, which now exists only when a conversation
  // could carry the quote. The same condition must gate both or the insert fails
  // on `service_quote_attribution_quote_id_fkey`.
  if (catalog && quoteConversationId && serviceOwners.length > 0) {
    await prisma.serviceQuoteAttribution.upsert({
      where: { serviceId: "demo-svc-1" },
      create: { serviceId: "demo-svc-1", quoteId: "demo-quote-1", ruleVersion: 1 },
      update: {},
    });
  }

  await seedMockOmieDataset(prisma, input.unitId);

  // Last, because it reads the services everything above just wrote. Demo
  // services carry a vehicle and a performedAt, so this opens one return per
  // demo vehicle with dates straddling overdue and upcoming — without it the
  // Follow-up return sections would be empty on a freshly seeded database.
  // services' own reconcile, the one the Omie import runs after every pull: its
  // writes go through db.tx under module_services (and module_scheduling for the
  // reminder stop), so the database's module roles must exist -- every seeding
  // path runs `pnpm db:migrate`, which applies them, first. Until the cleanup
  // after wave 5 the seed carried its own copy of this apply, because it lived in
  // packages/db and could not import core.
  const returns = await reconcileVehicleReturns(createDb(prisma));

  // A reminder plan on one demo return, so the model is visible in demo data
  // rather than only reachable by creating one by hand. Two triggers on one
  // message is the case the whole return/message/trigger split exists for: a
  // week before, and on the day.
  const demoReturn = await prisma.vehicleReturn.findFirst({
    where: { status: "OPEN" },
    orderBy: { returnDate: "asc" },
  });
  if (demoReturn) {
    await prisma.returnReminderMessage.upsert({
      where: { id: "demo-return-msg-1" },
      create: {
        id: "demo-return-msg-1",
        vehicleReturnId: demoReturn.id,
        bodyTemplate:
          "Oi! Já faz {tempo} desde a última troca de óleo do seu {veiculo}. " +
          "O intervalo recomendado é de {intervalo} — quer agendar a próxima?",
        createdByUserId: DEMO_USERS[0]!.id,
      },
      update: {},
    });
    const dayBefore = new Date(demoReturn.returnDate);
    dayBefore.setDate(dayBefore.getDate() - 7);
    for (const [suffix, when] of [
      ["semana", dayBefore],
      ["dia", demoReturn.returnDate],
    ] as const) {
      await prisma.scheduledMessage.upsert({
        where: { id: `demo-return-sm-${suffix}` },
        create: {
          id: `demo-return-sm-${suffix}`,
          returnReminderMessageId: "demo-return-msg-1",
          frozenText: "Oi! Já faz um tempo desde a última troca de óleo. Quer agendar?",
          scheduledAt: when,
          leadDays: suffix === "semana" ? 7 : 0,
          status: "SCHEDULED",
          idempotencyKey: `demo-return-idem-${suffix}`,
          createdByUserId: DEMO_USERS[0]!.id,
        },
        update: {},
      });
    }
  }

  // One archived Follow-up entry, so the closed-entry table is represented and
  // the "restaurar" path has something to show.
  // Its section is `unansweredQuotes` and its anchor is the quote id, so it
  // belongs on the quote's own conversation rather than an independently chosen
  // one — a closed unanswered-quote entry pointing at a thread with no quote
  // would be the contradiction this seed is supposed to avoid.
  if (quoteConversationId) {
    await prisma.followUpClosedEntry.deleteMany({
      where: { anchor: "demo-quote-1", NOT: { conversationId: quoteConversationId } },
    });
    await prisma.followUpClosedEntry.upsert({
      where: {
        section_conversationId_anchor: {
          section: "unansweredQuotes",
          conversationId: quoteConversationId,
          anchor: "demo-quote-1",
        },
      },
      create: {
        section: "unansweredQuotes",
        unitId: input.unitId,
        conversationId: quoteConversationId,
        anchor: "demo-quote-1",
        closedByUserId: DEMO_USERS[0]!.id,
      },
      update: {},
    });
  }

  return returns;
}

/** Prisma model names this seed is responsible for covering (plus base Unit/User/CatalogItem). */
/**
 * The pending prefill suggestion the demo seed writes, held to the response contract.
 *
 * Prisma types this column as `Json`, so nothing checks its shape at the call site — which
 * is how it shipped as `{ givenName: { value, confidence }, ... }`: keys the response schema
 * does not allow, wrapped in objects where it wants plain strings. `prefillFieldsSchema` is
 * `.strict()`, so GET /conversations/:id/prefill answered 500 for this conversation.
 *
 * Exported for `demo-seed.test.ts`, which parses it. A confidence has no place here at all:
 * the response contract has no such concept, and inventing one would be a second fiction.
 */
export const DEMO_PREFILL_PENDING_FIELDS = {
  name: "Ana Souza",
  plate: "ABC1D23",
  make: "Volkswagen",
} as const;

export const DEMO_COVERED_MODELS = [
  "Unit",
  "User",
  "UserUnit",
  "WhatsAppConnection",
  "WebhookEvent",
  "Conversation",
  "OutboxMessage",
  "Message",
  "Customer",
  "CustomerPhone",
  "CustomerEmail",
  "Vehicle",
  "CustomerFieldSync",
  "VehicleFieldSync",
  "CustomerReconciliationPending",
  "VehicleReconciliationPending",
  "Service",
  "ServiceItem",
  "CadastroPrefillJob",
  "Tag",
  "Template",
  "ConversationTag",
  "CadastroPrefillSuggestion",
  "SyncExecution",
  "IntegrationError",
  "ErpOutbox",
  "IntervalRule",
  "ScheduledMessage",
  "MotulCompatibility",
  "TecfilCompatibility",
  // Written by real retrieval, never by the seed — see PROVIDER_OWNED in demo-seed.live.test.ts.
  "OilSourceCandidate",
  "OilSpecSearchMiss",
  "OilManualIngestion",
  "OilManualDocument",
  "OilManualPage",
  "OilManualReading",
  // Written by background research (background-oil-research D21), never by the seed.
  "OilResearch",
  "OilResearchRun",
  "OilResearchRunner",
  // Written by an attendant's "Guardar para este modelo" (background-oil-research D24), never by the seed.
  "OilAttendantFill",
  "CatalogItem",
  "CatalogLubricant",
  "CatalogFilter",
  "OilQuote",
  "OilQuoteLine",
  "AttributionRule",
  "ServiceScheduledAttribution",
  "ServiceConversationAttribution",
  "ServiceQuoteAttribution",
  "VehicleReturn",
  "ReturnReminderMessage",
  "FollowUpClosedEntry",
  "PlateLookup",
  "PlateLookupCall",
] as const;
