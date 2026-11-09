/**
 * SQL/Prisma fixtures for Playwright. Runs after (or without) the demo seed.
 * Marks the live Evolution instance CONNECTED in Postgres only — does not call
 * Evolution and does not start the worker.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@select-lub/core/db";
import { E2E } from "./ids.js";
import { novaFirstInboundAt } from "./seed-novas.js";
import { assertSeedTargetIsLocal } from "./seed-target.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const FALLBACK_USER_ID = "a1111111-1111-4111-8111-111111111111";

/**
 * Placeholders the seeded tour template declares.
 *
 * `templateVariableSchema` is a closed enum of `nome_cliente` and `placa`, and
 * the API validates it when *reading* a row, so a template seeded with any
 * other name makes `GET /templates` answer 500 rather than being rejected at
 * write time.
 */
const TOUR_TEMPLATE_VARIABLES = ["nome_cliente", "placa"] as const;

/** Body of the seeded tour template, using only {@link TOUR_TEMPLATE_VARIABLES}. */
const TOUR_TEMPLATE_TEXT = "Olá {{nome_cliente}}, o retorno do {{placa}} está próximo.";

/**
 * Name prefix every catalog entry a tour creates must use.
 *
 * The Configurações tour creates a tag and a template each run. Cleaning up by
 * prefix keeps the sweep narrow: anything a person created by hand on the same
 * unit is left alone, which "delete everything that is not a fixture" would not
 * be. Kept next to the seed rather than in the tour so the two cannot drift.
 */
export const TOUR_CREATED_PREFIX = "Tour Config";

function jid(digits: string) {
  return `55${digits}@s.whatsapp.net`;
}

/**
 * Rows the retroactive tours (change `exploratory-tour-tests`, task 5.2) need
 * and that the four original fixtures do not provide: a customer with two
 * vehicles, a service whose vehicle return is already overdue and carries one
 * reminder, a tag and a template on the unit, and an oil-quote snapshot.
 *
 * Kept in its own function rather than inlined so the original fixtures stay
 * readable, and so the reason each row exists can be stated next to it.
 *
 * The quote is seeded as a header with no lines: `OilQuoteLine` requires a
 * `CatalogItem`, and the catalog is Motul and Tecfil data that the tour stack
 * deliberately cannot reach. A header alone is enough for a tour to observe
 * that a stored quote renders.
 *
 * @param prisma - Client already pointed at the guarded local target.
 * @param context - Unit, seeding user, and the run's reference instant.
 */
async function seedTourFixtures(
  prisma: PrismaClient,
  context: { unitId: string; createdByUserId: string; now: Date },
) {
  const { unitId, createdByUserId, now } = context;
  const servicedAt = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
  // A date, not an instant: `VehicleReturn.returnDate` is a calendar day. Well
  // past due, so the return lands in "Retorno vencido" whenever the suite runs
  // rather than drifting into "aproximando" as the clock moves.
  const dueDate = new Date(Date.UTC(
    servicedAt.getUTCFullYear(),
    servicedAt.getUTCMonth() + 6,
    servicedAt.getUTCDate(),
  ));

  const vehicles = [
    {
      id: E2E.tourVehicleAId,
      plate: E2E.tourVehicleAPlate,
      // No make and no version (background-oil-research task 5.5): the oil-quote
      // tour's incomplete-identity oracle, "…complete os dados do veículo: marca e
      // versão." (D17's own example). An incomplete identity queues no research.
      make: null,
      model: "Gol",
      year: 2019,
    },
    {
      id: E2E.tourVehicleBId,
      plate: E2E.tourVehicleBPlate,
      make: "Volkswagen",
      model: "Saveiro",
      year: 2021,
    },
    {
      // The oil-quote cached-row fixture, and the one vehicle here with a
      // COMPLETE identity. That is safe by construction since
      // background-oil-research PR 4: `GET quote-options` calls no provider — it
      // reads the cache rows below and the research state — so opening this car
      // opens on its stored options, with no reuse prompt.
      //
      // "Buscar novamente" is now a POST that only queues a research; nothing
      // runs it in a tour, which starts no worker. A worker on the same
      // database, though, would research this identity for real — which is why
      // the tours keep their own stack and database.
      //
      // NO PLATE, AND THAT IS DELIBERATE (close-stated-coverage-gaps 1.2b,
      // design decision 4). None of the customer's real plates resolves to a car
      // with a citable oil source, so giving one of them this identity would
      // invent provenance for it — and contradict what the plate provider
      // returns for that plate. The identity instead reuses a row the
      // real-provenance fixture already cites
      // (`packages/core/fixtures/oil-sources.json`, Polo 1.0 TSI 2021).
      id: E2E.quoteVehicleId,
      plate: null,
      make: E2E.quoteVehicleMake,
      model: E2E.quoteVehicleModel,
      version: E2E.quoteVehicleVersion,
      year: E2E.quoteVehicleYear,
    },
    {
      // A complete identity with NO cache row (background-oil-research task 5.5):
      // the `researching` + `paused: stopped` oracle. Opening its quote queues the
      // identity at the front, and the tour stack runs no worker, so it stays
      // queued with research reported as not running. Safe for the same reason as
      // the Polo: the quote path calls no provider.
      id: E2E.researchVehicleId,
      plate: null,
      make: E2E.researchVehicleMake,
      model: E2E.researchVehicleModel,
      version: E2E.researchVehicleVersion,
      year: E2E.researchVehicleYear,
    },
  ];
  // The vehicles tour adds a car from the rail, so without this the customer
  // grows one more vehicle per run and any "two vehicles" assertion drifts.
  // Restricted to this customer, and to rows the fixture does not own, so it
  // can never touch the demo dataset. Returns cascade from the vehicle; the
  // seeded pair is excluded, so the seeded return is untouched.
  await prisma.vehicle.deleteMany({
    where: {
      customerId: E2E.tourCustomerId,
      id: { notIn: [E2E.tourVehicleAId, E2E.tourVehicleBId, E2E.quoteVehicleId, E2E.researchVehicleId] },
    },
  });

  for (const vehicle of vehicles) {
    await prisma.vehicle.upsert({
      where: { id: vehicle.id },
      create: {
        id: vehicle.id,
        customerId: E2E.tourCustomerId,
        plate: vehicle.plate,
        make: vehicle.make,
        model: vehicle.model,
        version: vehicle.version ?? null,
        year: vehicle.year,
        origin: "crm",
      },
      // `make` and `version` are set on UPDATE as well as create. They were
      // create-only, and on 2026-09-14 that made the fixture uncorrectable: a
      // run that had briefly written the real plate identity left `make` "VW"
      // and `version` "1.0 FLEX 12V 4P" behind, and reverting the code could
      // not undo the data because no re-seed touched those columns. The row
      // became a hybrid whose identity was complete enough to reach the Motul
      // client, which is the one thing this stack must not do. Declaring a
      // field and not enforcing it on update is the same omission that left
      // `sourceType` stale on the conversations above.
      //
      // Vehicle A's `make` and `version` are deliberately null: an incomplete
      // identity queues no research, and `conversas-oil-quote.tour.spec.ts`
      // asserts the sentence that names both missing fields.
      update: {
        customerId: E2E.tourCustomerId,
        plate: vehicle.plate,
        make: vehicle.make,
        model: vehicle.model,
        version: vehicle.version ?? null,
        year: vehicle.year,
      },
    });
  }

  // Every run starts with no research state for the two complete identities
  // the oil-quote tour opens (review of #196). Opening a quote queues or adopts
  // a research row, and the row carries the Tecfil state too; left behind, the
  // next run would read an old `requestedAt`, or — had a worker shared this
  // database — a researched Kwid with cache rows of its own. The Kwid's caches,
  // misses and candidates are dropped for the same reason; the Polo's cache rows
  // are the fixture's and are rewritten below.
  const researchedIdentities = [
    { make: E2E.researchVehicleMake, year: E2E.researchVehicleYear, model: E2E.researchVehicleModel, version: E2E.researchVehicleVersion },
    { make: E2E.quoteVehicleMake, year: E2E.quoteVehicleYear, model: E2E.quoteVehicleModel, version: E2E.quoteVehicleVersion },
  ];
  const identityWhere = (identity: (typeof researchedIdentities)[number]) => ({
    year: identity.year,
    make: { equals: identity.make, mode: "insensitive" as const },
    model: { equals: identity.model, mode: "insensitive" as const },
    version: { equals: identity.version, mode: "insensitive" as const },
  });
  const researchRows = await prisma.oilResearch.findMany({
    where: { OR: researchedIdentities.map(identityWhere) },
    select: { identityKey: true },
  });
  const identityKeys = researchRows.map((row) => row.identityKey);
  await prisma.oilResearchRun.deleteMany({ where: { identityKey: { in: identityKeys } } });
  await prisma.oilResearch.deleteMany({ where: { identityKey: { in: identityKeys } } });
  const kwid = identityWhere(researchedIdentities[0]!);
  await prisma.motulCompatibility.deleteMany({ where: kwid });
  await prisma.tecfilCompatibility.deleteMany({ where: kwid });
  await prisma.oilSpecSearchMiss.deleteMany({ where: kwid });
  await prisma.oilSourceCandidate.deleteMany({ where: kwid });

  // Both halves of the oil-quote cache, owned here rather than borrowed from
  // the demo seed.
  //
  // WHY BOTH: the quote shows the Motul row's options and prices the filters
  // from the stored Tecfil row. With only the Motul row the cards still render,
  // but the filters read as not yet consulted (`pending`) — a state no tour
  // worker would ever resolve, since the tours run without one.
  //
  // The provenance is the demo fixture's, not invented: same vehicle, same
  // cited CarroRac page, same Tecfil catalogue answer. `consultedAt` is `now`
  // so this row is the most recent match and therefore the one
  // `latestCompatibility` returns, which keeps the tour reading the fixture it
  // declares rather than whichever row happens to be newer.
  //
  // `classification` is "" on purpose. That is what the cited document supports,
  // and it is the value that made `quote-options` return HTTP 500 until the
  // response schema was relaxed. Keeping it real is what lets this fixture
  // exercise that fix instead of stepping around it.
  const quoteMotul = {
    make: E2E.quoteVehicleMake,
    year: E2E.quoteVehicleYear,
    model: E2E.quoteVehicleModel,
    version: E2E.quoteVehicleVersion,
    viscosities: ["0W-20", "5W-40", "0W-40", "5W-30"],
    viscosity: "0W-20",
    classification: "",
    fillLiters: 4,
    fillKind: "em_servico",
    sourcePublisher: "CarroRac",
    sourceDocument: "Óleo de motor Volkswagen Polo — tabela de aplicação",
    sourcePage: "Polo AW (2017-2026), 1.0 TSI (70 kW)",
    sourceAuthority: null,
    sourceUrl: null,
    consultedAt: now,
  };
  await prisma.motulCompatibility.upsert({
    where: { id: E2E.quoteMotulCompatibilityId },
    create: { id: E2E.quoteMotulCompatibilityId, ...quoteMotul },
    // Enforced on update as well as create: a tour that refetched would rewrite
    // these columns, and a fixture that only works on a fresh row is the
    // omission this file has already paid for three times.
    update: quoteMotul,
  });

  const quoteTecfil = {
    make: E2E.quoteVehicleMake,
    year: E2E.quoteVehicleYear,
    model: E2E.quoteVehicleModel,
    version: E2E.quoteVehicleVersion,
    manufacturerLabel: "VOLKSWAGEN",
    vehicleLabel: "POLO",
    engineLabel: "1.0 12V 128cv",
    matchedBy: { engine: "exact", vehicle: "exact", manufacturer: "exact" },
    oilFilters: [
      {
        description: "Lubrificante",
        tecfilNumber: "PSL545",
        tecfilProductCode: 857,
        crossReferences: [{ brand: "Authomix", number: "FOL0545" }],
      },
    ],
    fuelFilters: [
      {
        description: "Combustível",
        tecfilNumber: "GI50/7",
        tecfilProductCode: 46,
        crossReferences: [{ brand: "Authomix", number: "FCO0507" }],
      },
    ],
    consultedAt: now,
  };
  await prisma.tecfilCompatibility.upsert({
    where: { id: E2E.quoteTecfilCompatibilityId },
    create: { id: E2E.quoteTecfilCompatibilityId, ...quoteTecfil },
    update: quoteTecfil,
  });

  await prisma.service.upsert({
    where: { id: E2E.tourReturnServiceId },
    create: {
      id: E2E.tourReturnServiceId,
      customerId: E2E.tourCustomerId,
      vehicleId: E2E.tourVehicleAId,
      unitId,
      performedAt: servicedAt,
      description: "Troca de óleo e2e retorno",
      kind: "oil",
      status: "done",
      origin: "omie",
      omieId: "e2e-omie-os-return",
    },
    update: {
      customerId: E2E.tourCustomerId,
      vehicleId: E2E.tourVehicleAId,
      unitId,
      performedAt: servicedAt,
      origin: "omie",
    },
  });

  // Reminders cascade from the return, but the return itself is upserted rather
  // than deleted, so the reminder is cleared explicitly to keep re-seeding
  // idempotent instead of accumulating one row per run.
  //
  // The scheduled messages go first: confirming the Follow-up reminder form
  // writes one per notice moment, and the Follow-up row prints how many
  // reminders a return has ("1 lembrete · próximo …"). Left behind, they would
  // climb by one per tour run and take that summary with them.
  await prisma.scheduledMessage.deleteMany({
    where: { customerId: E2E.tourCustomerId },
  });
  await prisma.returnReminderMessage.deleteMany({
    where: { vehicleReturnId: E2E.tourReturnId },
  });
  await prisma.vehicleReturn.upsert({
    where: { id: E2E.tourReturnId },
    create: {
      id: E2E.tourReturnId,
      vehicleId: E2E.tourVehicleAId,
      sourceServiceId: E2E.tourReturnServiceId,
      returnDate: dueDate,
      status: "OPEN",
    },
    update: {
      vehicleId: E2E.tourVehicleAId,
      sourceServiceId: E2E.tourReturnServiceId,
      returnDate: dueDate,
      status: "OPEN",
      archivedAt: null,
      archivedByUserId: null,
    },
  });
  await prisma.returnReminderMessage.create({
    data: {
      id: E2E.tourReminderId,
      vehicleReturnId: E2E.tourReturnId,
      bodyTemplate: "Olá! Passou da hora da revisão do seu carro.",
      createdByUserId,
    },
  });

  // The Configurações tour creates a catalog entry per run. Scoped to this
  // one naming prefix rather than to "everything that is not the fixture", so
  // a tag or template a person made by hand on the same unit is never at risk.
  // Applications go first: `Tag.applies` restricts the delete.
  // Drop the plate-lookup CACHE for the two plates the cadastro tour drives.
  //
  // `lookup.ts` guards BOTH `recordCall` and `saveLookup` with `if (!isMock)`, so
  // a mock answer is never billed and never cached. A cache row for these plates
  // can therefore only have been written by a real provider call — and the cache
  // is consulted before any provider, so such a row silently decides what the
  // tour sees. Deleting it is what makes the mock authoritative here, and it
  // turns any row that reappears into direct evidence that a run went live.
  //
  // It has gone wrong once already. On 2026-09-10 the tour reached the real
  // APIBrasil: the config blanked `PLACAS_TOKEN`, a name nothing reads, while
  // `resolvePlacasAccess` reads `APIBRASIL_BEARER_TOKEN` and resolves
  // credentials BEFORE the mock opt-in. That billed call cached `DEF2E34` as a
  // HONDA CIVIC 2001 — the real registered vehicle — where the canned dataset
  // says HONDA FIT 1.5 2019. The tour passed anyway, because it only asserted
  // the fields were non-empty, and its run report recorded the live answer as
  // "a mock hit".
  //
  // The credential is fixed (f6addf6) and the assertions now pin the canned
  // values, so the contamination finally showed as `Expected "FIT", Received
  // "CIVIC"`. The pin is what surfaces it; this delete is what clears it.
  //
  // The CACHE only. `plate_lookup_call` is an append-only billing log that no
  // answer path consults (`listCalls` is a read-only audit listing), and its
  // 2026-09-10 row is the evidence the leak fired. Deleting it would erase the
  // record and change no behaviour.
  await prisma.plateLookup.deleteMany({
    where: { plate: { in: [E2E.tourKnownPlate, E2E.tourUnknownPlate] } },
  });

  const tourCreated = { name: { startsWith: TOUR_CREATED_PREFIX } };
  await prisma.conversationTag.deleteMany({ where: { tag: tourCreated } });
  await prisma.tag.deleteMany({ where: { unitId, ...tourCreated } });
  await prisma.template.deleteMany({ where: { unitId, ...tourCreated } });

  await prisma.tag.upsert({
    where: { id: E2E.tourTagId },
    create: {
      id: E2E.tourTagId,
      unitId,
      name: E2E.tourTagName,
      // A theme role, not a hex string: `tagColorSchema` accepts only
      // primary|secondary|error|warning|info, and a row outside that domain
      // makes `GET /tags/apply-options` throw a ZodError and answer 500.
      color: "primary",
    },
    // `color` belongs in both branches: an upsert that sets it only on create
    // leaves a row seeded by an earlier version of this file untouched, and a
    // stale out-of-domain colour makes the tag endpoints answer 500.
    update: { unitId, name: E2E.tourTagName, color: "primary", active: true },
  });
  await prisma.template.upsert({
    where: { id: E2E.tourTemplateId },
    create: {
      id: E2E.tourTemplateId,
      unitId,
      name: E2E.tourTemplateName,
      text: TOUR_TEMPLATE_TEXT,
      allowedVariables: TOUR_TEMPLATE_VARIABLES,
      status: "active",
    },
    // Same reasoning as the tag's colour: `allowedVariables` is validated on
    // read, so leaving it out of the update branch would let a row written by
    // an earlier version of this file keep making `GET /templates` answer 500.
    update: {
      unitId,
      name: E2E.tourTemplateName,
      text: TOUR_TEMPLATE_TEXT,
      allowedVariables: TOUR_TEMPLATE_VARIABLES,
      status: "active",
    },
  });

  await prisma.oilQuote.upsert({
    where: { id: E2E.tourOilQuoteId },
    create: {
      id: E2E.tourOilQuoteId,
      customerId: E2E.tourCustomerId,
      vehicleId: E2E.tourVehicleAId,
      conversationId: E2E.tourConversationId,
      generatedMessageText: "Orçamento e2e: troca de óleo do Gol.",
      createdByUserId,
    },
    update: {
      customerId: E2E.tourCustomerId,
      vehicleId: E2E.tourVehicleAId,
      conversationId: E2E.tourConversationId,
    },
  });
}

/**
 * Upserts the five e2e conversations (nameless, cadastro, send, schedule, tour)
 * and forces the live WhatsApp connection row to CONNECTED.
 */
export async function seedE2eFixtures() {
  // Must run AFTER the module-scope loadEnvFile above — before it, DATABASE_URL
  // may be unset and the guard would refuse a perfectly good local target — and
  // BEFORE `new PrismaClient()`, so no client holding a remote connection string
  // is ever constructed. That makes the refusal a property of control flow
  // rather than a convention the next edit has to remember. This is also the
  // per-test path: `fixtures.ts` re-seeds before every spec through an auto
  // fixture, so the guard sits on both entry points rather than on globalSetup
  // alone.
  assertSeedTargetIsLocal();
  const prisma = new PrismaClient();
  const now = new Date();
  const performedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "Select Lub";
  const createdByUserId = process.env.SEED_USER_A_ID?.trim() || FALLBACK_USER_ID;

  try {
    const unit =
      (await prisma.unit.findFirst({ where: { name: "Select Lub" } })) ??
      (await prisma.unit.create({ data: { name: "Select Lub" } }));

    await prisma.user.upsert({
      where: { id: createdByUserId },
      create: { id: createdByUserId, email: "e2e-attendant@selectlub.example", name: "E2E Atendente" },
      update: {},
    });
    await prisma.userUnit.upsert({
      where: { userId_unitId: { userId: createdByUserId, unitId: unit.id } },
      create: { userId: createdByUserId, unitId: unit.id },
      update: {},
    });

    const connection = await prisma.whatsAppConnection.upsert({
      where: { instanceName },
      create: {
        instanceName,
        unitId: unit.id,
        provider: "EVOLUTION_BAILEYS",
        connectionState: "CONNECTED",
      },
      update: { connectionState: "CONNECTED", unitId: unit.id },
    });

    const customers = [
      { id: E2E.namelessCustomerId, phone: E2E.namelessPhone, name: null as string | null },
      { id: E2E.cadastroCustomerId, phone: E2E.cadastroPhone, name: null as string | null },
      { id: E2E.sendCustomerId, phone: E2E.sendPhone, name: "E2E Envio" as string | null },
      { id: E2E.scheduleCustomerId, phone: E2E.schedulePhone, name: "E2E Agenda" as string | null },
      { id: E2E.tourCustomerId, phone: E2E.tourPhone, name: E2E.tourName as string | null },
      // Names deliberately null: the prefill ghost suggests a name, and a
      // customer that already has one cannot show the accept changing anything.
      {
        id: E2E.prefillAcceptCustomerId,
        phone: E2E.prefillAcceptPhone,
        name: null as string | null,
      },
      {
        id: E2E.prefillDismissCustomerId,
        phone: E2E.prefillDismissPhone,
        name: null as string | null,
      },
      {
        id: E2E.omieConflictCustomerId,
        phone: E2E.omieConflictPhone,
        name: E2E.omieConflictCustomerName as string | null,
      },
      {
        id: E2E.disconnectedCustomerId,
        phone: E2E.disconnectedPhone,
        name: E2E.disconnectedCustomerName as string | null,
      },
    ];

    for (const row of customers) {
      await prisma.customer.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          name: row.name,
          unitId: unit.id,
          origin: "crm",
          status: "active",
          country: "BR",
        },
        update: { name: row.name, unitId: unit.id },
      });
      await prisma.customerPhone.upsert({
        where: { customerId_normalized: { customerId: row.id, normalized: row.phone } },
        create: {
          id: `${row.id}-phone`,
          customerId: row.id,
          raw: row.phone,
          normalized: row.phone,
          isPrimary: true,
        },
        update: { raw: row.phone, isPrimary: true },
      });
    }

    // `sourceType` is pinned on every row, and pinned on UPDATE as well as on
    // create. Leaving it to the schema default (`UNKNOWN`) is not enough: the
    // demo seed classifies conversations round-robin and scopes that sweep to
    // rows still `UNKNOWN`, which is exactly what these are. So any run that
    // shells out to `db:seed` — several `.live.test.ts` files do — rewrites
    // these rows to `AD`/`ORGANIC` behind the suite's back, and a later e2e seed
    // would not put them back. `conversas-inbox.tour.spec.ts` walks the conversas
    // scenario "Unknown is not labelled organic", so the tour row must really be
    // `UNKNOWN` for that scenario to be reachable at all; it went green on a
    // fresh fixture and red after a full `pnpm test`, which is the signature of a
    // precondition nobody establishes. The other four keep the values the sweep
    // had been handing them, so the origin mix the Relatórios screens aggregate
    // does not shift.
    const conversations = [
      {
        id: E2E.namelessConversationId,
        customerId: E2E.namelessCustomerId,
        phone: E2E.namelessPhone,
        sourceType: "AD",
      },
      {
        id: E2E.cadastroConversationId,
        customerId: E2E.cadastroCustomerId,
        phone: E2E.cadastroPhone,
        sourceType: "AD",
      },
      {
        id: E2E.sendConversationId,
        customerId: E2E.sendCustomerId,
        phone: E2E.sendPhone,
        sourceType: "ORGANIC",
      },
      {
        id: E2E.scheduleConversationId,
        customerId: E2E.scheduleCustomerId,
        phone: E2E.schedulePhone,
        sourceType: "AD",
      },
      {
        id: E2E.tourConversationId,
        customerId: E2E.tourCustomerId,
        phone: E2E.tourPhone,
        sourceType: "UNKNOWN",
      },
      {
        id: E2E.prefillAcceptConversationId,
        customerId: E2E.prefillAcceptCustomerId,
        phone: E2E.prefillAcceptPhone,
        sourceType: "ORGANIC",
      },
      {
        id: E2E.prefillDismissConversationId,
        customerId: E2E.prefillDismissCustomerId,
        phone: E2E.prefillDismissPhone,
        sourceType: "ORGANIC",
      },
      {
        id: E2E.omieConflictConversationId,
        customerId: E2E.omieConflictCustomerId,
        phone: E2E.omieConflictPhone,
        sourceType: "ORGANIC",
      },
    ];

    for (const row of conversations) {
      // Pinned on UPDATE as well as on create, like `sourceType`: a database
      // seeded days ago would otherwise keep the instants of its first run and
      // leave Relatórios' default period empty. See `seed-novas.ts`.
      const firstInboundAt = novaFirstInboundAt(now, row.id);
      await prisma.conversation.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          whatsappConnectionId: connection.id,
          remoteJid: jid(row.phone),
          customerId: row.customerId,
          chatKey: row.phone,
          sourceType: row.sourceType,
          startedAt: firstInboundAt,
          lastMessageAt: now,
          firstInboundAt,
          lastInboundAt: now,
        },
        update: {
          whatsappConnectionId: connection.id,
          customerId: row.customerId,
          chatKey: row.phone,
          remoteJid: jid(row.phone),
          sourceType: row.sourceType,
          startedAt: firstInboundAt,
          firstInboundAt,
          lastMessageAt: now,
        },
      });
      await prisma.message.upsert({
        where: {
          conversationId_externalMessageId: {
            conversationId: row.id,
            externalMessageId: `${row.id}-inbound`,
          },
        },
        create: {
          conversationId: row.id,
          externalMessageId: `${row.id}-inbound`,
          direction: "inbound",
          messageType: "text",
          textBody: "oi",
          providerTimestamp: now,
        },
        update: { textBody: "oi", providerTimestamp: now },
      });
    }

    // Assistive-prefill ghosts, one to accept and one to dismiss.
    //
    // Seeded as the PRODUCT of an extraction, never by running one. The tour
    // stack blanks `OPENAI_API_KEY` on purpose, so a ghost can
    // only exist here if the row is written directly — which is also the honest
    // fixture: what the tour walks is the accept and dismiss behaviour, not the
    // model's ability to extract.
    //
    // Own customers, not the tour customer: accepting a ghost WRITES these
    // fields onto the conversation's customer, so parking one on the tour
    // customer would rewrite what `conversas-cadastro.tour.spec.ts` asserts the
    // first time the accept tour ran.
    //
    // Two conversations because `conversationId` is unique on the suggestion —
    // one conversation cannot hold both an accepted and a dismissed ghost.
    for (const ghost of [
      {
        conversationId: E2E.prefillAcceptConversationId,
        jobId: E2E.prefillAcceptJobId,
        suggestionId: E2E.prefillAcceptSuggestionId,
      },
      {
        conversationId: E2E.prefillDismissConversationId,
        jobId: E2E.prefillDismissJobId,
        suggestionId: E2E.prefillDismissSuggestionId,
      },
    ]) {
      const job = {
        conversationId: ghost.conversationId,
        status: "done",
        dirty: false,
        lastError: null,
      };
      await prisma.cadastroPrefillJob.upsert({
        where: { id: ghost.jobId },
        create: { id: ghost.jobId, ...job },
        // Enforced on update as well as create: a job left `error` or `dirty` by
        // an earlier run would hide the ghost behind a retry state, and the
        // fixture would be uncorrectable by re-seeding. Same omission that left
        // `sourceType` and the vehicle identity stale above.
        update: job,
      });
      const suggestion = {
        conversationId: ghost.conversationId,
        jobId: ghost.jobId,
        extractedAt: now,
        // The SHAPE here is the contract, and it is easy to get wrong: keys come
        // from `prefillFieldKeySchema` (name, taxId, plate, make, model,
        // version, year, odometerKm), the object is `.strict()`, and the values
        // are PLAIN strings and numbers. There is no confidence wrapper —
        // `mapPrefillView` passes this straight into the response DTO with no
        // transform, so anything else is a 500 at serialization rather than a
        // validation error the screen could show.
        //
        // Measured 2026-09-16: seeded first as
        // `{ givenName: { value, confidence } }` and opening the conversation
        // returned HTTP 500 `unrecognized_keys`. That is also the shape
        // `packages/core/prisma/seed/demo.ts` writes, so its own prefill fixture
        // has the same defect; reported, not fixed here.
        //
        // `name` alone, deliberately: the customer is seeded with a null name,
        // so accepting is observable as the name appearing and dismissing is
        // observable as it staying null. A field whose accept writes a VEHICLE
        // (plate, make, model) would need a vehicle fixture to mean anything.
        fields: { name: E2E.prefillSuggestedName },
      };
      await prisma.cadastroPrefillSuggestion.upsert({
        where: { conversationId: ghost.conversationId },
        create: { id: ghost.suggestionId, ...suggestion },
        // Also enforced on update: the accept tour CONSUMES its suggestion, so
        // without this the ghost exists on the first run and is gone on the
        // second. A fixture that only works once is worse than none.
        update: suggestion,
      });
    }

    // Omie reconciliation conflict: one linked customer holding TWO open
    // pendings on different fields.
    //
    // Two, not one, because the panel's count is of FIELDS rather than
    // customers — `prefill.tsx` says so in its own comment — and a single
    // conflict cannot tell those two readings apart. A tour asserting "1" would
    // pass under either.
    //
    // The linkage is what makes a pending coherent: a conflict is CRM and Omie
    // disagreeing, which cannot arise on a customer Omie has never seen.
    // The COLUMNS as well as the linkage. A pending says "CRM holds X, Omie
    // holds Y", so the customer must actually hold X or the fixture contradicts
    // itself — and a tour asserting that resolving applied Omie's value would
    // pass vacuously against a row that already held it.
    //
    // This is not hypothetical. The 2.4 drive resolved `city` to the Omie side,
    // and because nothing here rewrote the column, the tour's own precondition
    // caught it on the very next run: `expect(storedCity()).not.toBe(omie)`
    // failed. Third instance of the same omission in this file — declare a
    // field and you must enforce it on every run, not only the first.
    await prisma.customer.update({
      where: { id: E2E.omieConflictCustomerId },
      data: {
        omieId: E2E.omieConflictOmieId,
        origin: "omie",
        city: E2E.omieConflictCityCrm,
        postalCode: E2E.omieConflictPostalCrm,
      },
    });

    // Swept by owning customer rather than by id: resolving a pending in a tour
    // sets its status, and a resolved row left behind would make the next run
    // start from a different state than this one declares.
    await prisma.customerReconciliationPending.deleteMany({
      where: { customerId: E2E.omieConflictCustomerId },
    });
    for (const pending of [
      {
        fieldKey: "city",
        crmValue: E2E.omieConflictCityCrm,
        omieValue: E2E.omieConflictCityOmie,
      },
      {
        fieldKey: "postalCode",
        crmValue: E2E.omieConflictPostalCrm,
        omieValue: E2E.omieConflictPostalOmie,
      },
    ]) {
      await prisma.customerReconciliationPending.create({
        data: {
          id: `e2e-pending-${pending.fieldKey}`,
          customerId: E2E.omieConflictCustomerId,
          fieldKey: pending.fieldKey,
          crmValue: pending.crmValue,
          omieValue: pending.omieValue,
          // Both sides moved since the last agreed version, which is what the
          // spec calls a dual change and the only thing that opens a pending.
          localVersion: 2,
          externalVersion: 2,
          status: "open",
        },
      });
    }

    // A SECOND WhatsApp connection, deliberately not CONNECTED, with its own
    // conversation. Driven only by `playwright.tours-disconnected.config.ts`,
    // which points that API process's `EVOLUTION_INSTANCE_NAME` here.
    //
    // Separate instance rather than a flipped state on the shared one: every
    // other tour needs CONNECTED, and a tour that mutates shared state leaves
    // the database wrong whenever it fails partway — which tours do, by design,
    // while being written.
    //
    // WHY A SEPARATE CONFIG IS ALSO NEEDED, since the row alone looks like it
    // should be enough: `channelStatus()` resolves the connection by the
    // CONFIGURED instance name, not by unit, so this row is invisible to the
    // screen unless a process is pointed at it. Seeding it without that config
    // would leave the composer enabled and nothing to tour.
    //
    // The state is enforced on UPDATE as well as CREATE. A tour cannot reconnect
    // this instance today, but the rule has been broken three times in this file
    // already and the cost of holding it is one line.
    const disconnectedConnection = {
      unitId: unit.id,
      provider: "EVOLUTION_BAILEYS",
      connectionState: "DISCONNECTED",
    };
    await prisma.whatsAppConnection.upsert({
      where: { instanceName: E2E.disconnectedInstanceName },
      create: {
        id: E2E.disconnectedConnectionId,
        instanceName: E2E.disconnectedInstanceName,
        ...disconnectedConnection,
      },
      update: disconnectedConnection,
    });

    const disconnectedConversation = {
      whatsappConnectionId: E2E.disconnectedConnectionId,
      customerId: E2E.disconnectedCustomerId,
      chatKey: E2E.disconnectedPhone,
      remoteJid: jid(E2E.disconnectedPhone),
      sourceType: "ORGANIC",
      lastMessageAt: now,
    };
    await prisma.conversation.upsert({
      where: { id: E2E.disconnectedConversationId },
      create: {
        id: E2E.disconnectedConversationId,
        ...disconnectedConversation,
        startedAt: now,
        firstInboundAt: now,
        lastInboundAt: now,
      },
      update: disconnectedConversation,
    });
    await prisma.message.upsert({
      where: {
        conversationId_externalMessageId: {
          conversationId: E2E.disconnectedConversationId,
          externalMessageId: `${E2E.disconnectedConversationId}-inbound`,
        },
      },
      create: {
        conversationId: E2E.disconnectedConversationId,
        externalMessageId: `${E2E.disconnectedConversationId}-inbound`,
        direction: "inbound",
        messageType: "text",
        textBody: "oi",
        providerTimestamp: now,
      },
      update: { textBody: "oi", providerTimestamp: now },
    });

    // A done service on the disconnected customer, so the rail offers a schedule
    // control at all. The refusal being toured is that scheduling is blocked
    // while the channel is down; on a customer with no services there is no
    // control to block, and the assertion would pass for the wrong reason.
    const disconnectedService = {
      customerId: E2E.disconnectedCustomerId,
      unitId: unit.id,
      performedAt,
      origin: "omie",
    };
    await prisma.service.upsert({
      where: { id: E2E.disconnectedServiceId },
      create: {
        id: E2E.disconnectedServiceId,
        ...disconnectedService,
        description: "Troca de óleo e2e canal fora",
        kind: "oil",
        status: "done",
        omieId: "e2e-omie-os-desconectado",
      },
      update: disconnectedService,
    });

    await prisma.scheduledMessage.deleteMany({
      where: { customerId: E2E.scheduleCustomerId },
    });
    await prisma.service.deleteMany({
      where: {
        customerId: E2E.scheduleCustomerId,
        id: { notIn: [E2E.freeServiceId, E2E.occupiedServiceId] },
      },
    });
    await prisma.outboxMessage.deleteMany({
      where: { conversationId: { in: conversations.map((row) => row.id) } },
    });

    await prisma.service.upsert({
      where: { id: E2E.freeServiceId },
      create: {
        id: E2E.freeServiceId,
        customerId: E2E.scheduleCustomerId,
        unitId: unit.id,
        performedAt,
        description: "Troca de óleo e2e livre",
        kind: "oil",
        status: "done",
        origin: "omie",
        omieId: "e2e-omie-os-free",
      },
      update: {
        customerId: E2E.scheduleCustomerId,
        unitId: unit.id,
        performedAt,
        origin: "omie",
        omieId: "e2e-omie-os-free",
      },
    });
    await prisma.service.upsert({
      where: { id: E2E.occupiedServiceId },
      create: {
        id: E2E.occupiedServiceId,
        customerId: E2E.scheduleCustomerId,
        unitId: unit.id,
        performedAt: new Date(performedAt.getTime() + 60_000),
        description: "Troca de óleo e2e ocupado",
        kind: "oil",
        status: "done",
        origin: "omie",
        omieId: "e2e-omie-os-occupied",
      },
      update: {
        customerId: E2E.scheduleCustomerId,
        unitId: unit.id,
        origin: "omie",
        omieId: "e2e-omie-os-occupied",
      },
    });

    // `upsert`, not `create`, and it is the only write in this block that ever
    // needed changing. On 2026-09-12 a tour run died right here on
    // `Unique constraint failed on the fields: (id)`, five tours red out of 43.
    //
    // The cause is NOT the race it first looks like. The `deleteMany` above is
    // scoped by `customerId`, but the id below is FIXED — so a row carrying
    // this id under any OTHER customer is invisible to that delete, and the
    // create then collides with it every single time. An interrupted run is
    // enough to leave one; no concurrency is required. (Diagnosed by session
    // `local_ccd08bdb`, who had interrupted several runs that night. My own
    // first reading was "a concurrent writer recreated the row between the
    // delete and the create", which fits the moving failures but is the weaker
    // explanation and would have sent the next person hunting for a second
    // process that need not exist.)
    //
    // Upserting on the id fixes both readings, because it does not care which
    // customer owns the row. Every neighbouring write is already an upsert;
    // this was the odd one out, and the only one that could fail a whole run
    // rather than one assertion. Same family as the `sourceType` fix: a seed
    // that is idempotent only along the path it expects.
    //
    // Both branches set every field, deliberately. Setting them only on `create`
    // leaves a stale row broken for good, which is a mistake this repo's seeds
    // have made three times. `idempotencyKey` is derived from `now`, so it
    // differs per run and must be written on update too or the row keeps the
    // first run's key forever.
    const occupiedSchedule = {
      customerId: E2E.scheduleCustomerId,
      conversationId: E2E.scheduleConversationId,
      serviceId: E2E.occupiedServiceId,
      frozenText: "occupied fixture",
      scheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      status: "SCHEDULED" as const,
      idempotencyKey: `e2e-occupied-${now.getTime()}`,
      createdByUserId,
    };
    await prisma.scheduledMessage.upsert({
      where: { id: E2E.occupiedScheduleId },
      create: { id: E2E.occupiedScheduleId, ...occupiedSchedule },
      update: occupiedSchedule,
    });

    await seedTourFixtures(prisma, { unitId: unit.id, createdByUserId, now });
  } finally {
    await prisma.$disconnect();
  }
}
