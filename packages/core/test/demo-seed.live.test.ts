/**
 * Test design (testing-strategy)
 *
 * Moved from `packages/db/src` in adopt-modular-vertical-slices 5.1c, unchanged but
 * for its import paths. It sits in `packages/core/test/` beside the other live
 * suites rather than in `src/kernel/prisma/`: one case is ~345 lines, over the
 * 300-line limit that applies under `src/`.
 *
 * Setup: live Prisma against a SCRATCH database, `<DATABASE_URL's db>_demo_seed_live`,
 * on the same server: created and migrated in beforeAll, dropped in afterAll
 * (scratch-database.ts). Until the cleanup after wave 5 it ran on the shared test
 * database and left its fixture there every run. The loopback check runs first:
 * a remote DATABASE_URL fails the file, an unset one skips it. Conversations are
 * INSERTED BY THIS FILE before seeding, standing in for ones the WhatsApp
 * webhook delivered — the property under test is "the seed did not create
 * them", and a row this file wrote satisfies that exactly as a real one does.
 *
 * Oracle: demo-seed — the seed creates no Conversation, WebhookEvent or
 * OutboxMessage rows; it writes Message rows with origin SEED; demo connections
 * carry no conversation while every connectionState stays demonstrable; a second
 * run changes no counts except that SEED messages already exist.
 *
 * Axes
 *   A1 seed runs — 1 vs 2 (idempotence)
 *   A2 conversations present — none vs several
 *   A3 reply activity — seeded outbound vs inbound-only (only outbound may take a quote)
 *
 * Outputs
 *   O1 Conversation, WebhookEvent, OutboxMessage stay at the counts the test wrote
 *   O2 Message grows by SEED rows on the first run and stays on the second
 *   O3 every model the seed IS responsible for has ≥1 row
 *   O4 four connection states exist, none of them carrying a conversation
 *
 * What would make a test fail:
 *   The seed inventing a conversation, which is the whole change. A demo
 *   connection acquiring one, which would put fabricated rows into every report,
 *   since report queries scope by the connection's unit and these share it.
 *   Asserting only that conversation counts are unchanged without also creating
 *   any — that passes trivially against a seed which cannot write them at all,
 *   which is why A2 has both arms.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withConnectRetry } from "../src/testing/connect-retry.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";
import { CATALOG_SEED_ROWS, seedCatalogItems } from "../src/kernel/prisma/catalog-seed.js";
import { seedDemoDataset } from "../prisma/seed/demo.js";
import { shouldRunLiveTests } from "../src/kernel/prisma/live-test-gate.js";
import { MESSAGE_ORIGIN_LIVE, MESSAGE_ORIGIN_SEED } from "../src/shared/message-origin.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// First, before any database is created: a non-loopback DATABASE_URL throws here
// (fails, never skips), and an unset one skips the file.
const hasDatabase = shouldRunLiveTests();

const repoRoot = resolve(import.meta.dirname, "../../..");

/** Creating and migrating the scratch (37 migrations and the grants), or dropping it. */
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

/** Tables the seed must never write. Message is now SEED history on real conversations. */
/**
 * Models the demo seed deliberately does not write, so "every model has rows" skips them.
 *
 * The first three belong to the WhatsApp provider. The two oil ledgers belong to real
 * retrieval: a candidate row asserts that a search found and refused a specific document,
 * and a miss row asserts that a search happened and found nothing. The seed has no fixture
 * citing either, and its own rule is that it "must not invent a spec that no cited document
 * supports" — inventing the provenance of a search is the same fabrication. A seeded miss
 * would also suppress web search for that car for a week, demonstrating the opposite of the
 * feature.
 */
const PROVIDER_OWNED = [
  "Conversation",
  "WebhookEvent",
  "OutboxMessage",
  "OilSourceCandidate",
  "OilSpecSearchMiss",
  // Written by manual ingestion (ingest-harvested-manuals), never by the seed.
  "OilManualIngestion",
  "OilManualDocument",
  "OilManualPage",
  "OilManualReading",
  // Written by background research, never by the seed: background-oil-research D21 says
  // `db:seed` inserts no research rows, so a seeded database starts no research and no job
  // finds a row the seed invented.
  "OilResearch",
  "OilResearchRun",
  "OilResearchRunner",
  // Typed by an attendant (background-oil-research D24), never by the seed.
  "OilAttendantFill",
] as const;

describe.skipIf(!hasDatabase)("live demo seed", () => {
  // A scratch database of its own, created, migrated and dropped per run: this
  // file commits (it measures the seed across every table), and on the shared
  // database its fixture and everything the seed hung off it outlived the run.
  // See scratch-database.ts. The loopback check above has already run.
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "demo_seed_live", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  // Runs whether the cases passed or failed: a scratch left behind is also
  // dropped by the next run's setup, but that is the fallback, not the plan.
  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  async function counts() {
    const models = Prisma.dmmf.datamodel.models.map((model) => model.name);
    const entries = await Promise.all(
      models.map(async (name) => {
        const delegate = (prisma as unknown as Record<string, { count: () => Promise<number> }>)[
          name[0]!.toLowerCase() + name.slice(1)
        ];
        return [name, await delegate.count()] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async function seed(unitId: string, unitBId: string) {
    await seedDemoDataset(prisma, {
      unitId,
      unitBId,
      liveInstanceName: process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc",
    });
  }

  /**
   * Stand in for the WhatsApp channel: a connection that is not one of the demo
   * ones, carrying conversations the seed did not create. Half are answered, so
   * the quote role has something it may legitimately sit on and the unanswered
   * arm of A3 is present in the same run.
   */
  async function givenRealConversations(unitId: string, howMany: number) {
    const connection = await prisma.whatsAppConnection.upsert({
      where: { instanceName: "live-test-inbound" },
      create: {
        id: "live-test-inbound",
        instanceName: "live-test-inbound",
        unitId,
        provider: "EVOLUTION_BAILEYS",
        connectionState: "CONNECTED",
      },
      update: { unitId },
    });

    // Reset exactly the fields the seed writes, so a second run starts where the
    // first one did. Without this the file passed once and failed ever after:
    // the conversations are upserted with `update: {}`, nothing is torn down,
    // and section 3.2 deliberately attaches `operator-attached` to
    // `live-conv-01` — which the next run then read as "the seed failed to
    // decorate it". The failure named the seed for a defect that was entirely in
    // the fixture, which is the expensive kind.
    await prisma.conversation.updateMany({
      where: { id: { startsWith: "live-conv-" } },
      data: { customerId: null, sourceType: "UNKNOWN", ctwaClid: null },
    });
    await prisma.message.deleteMany({
      where: { conversationId: { startsWith: "live-conv-" }, origin: MESSAGE_ORIGIN_SEED },
    });
    await prisma.message.updateMany({
      where: { conversationId: { startsWith: "live-conv-" }, origin: MESSAGE_ORIGIN_LIVE },
      data: { shouldReply: null },
    });

    for (let index = 0; index < howMany; index += 1) {
      const id = `live-conv-${String(index + 1).padStart(2, "0")}`;
      const inbound = new Date(Date.UTC(2027, 4, 10, 12, 0, 0) + index * 3_600_000);
      const answered = index % 2 === 0;
      await prisma.conversation.upsert({
        where: { id },
        create: {
          id,
          whatsappConnectionId: connection.id,
          chatKey: `5519${String(900000000 + index)}`,
          remoteJid: `55519${String(900000000 + index)}@s.whatsapp.net`,
          sourceType: "UNKNOWN",
          startedAt: inbound,
          firstInboundAt: inbound,
          lastInboundAt: inbound,
          firstOutboundAt: answered ? new Date(inbound.getTime() + 45 * 60_000) : null,
          lastOutboundAt: answered ? new Date(inbound.getTime() + 45 * 60_000) : null,
          lastMessageAt: inbound,
        },
        update: {
          firstInboundAt: inbound,
          lastInboundAt: inbound,
          firstOutboundAt: answered ? new Date(inbound.getTime() + 45 * 60_000) : null,
          lastOutboundAt: answered ? new Date(inbound.getTime() + 45 * 60_000) : null,
          lastMessageAt: inbound,
        },
      });

      // Two real messages per conversation: an inbound, and a reply on the
      // answered ones. Needed so the exchange-untouched assertion has timestamps
      // and bodies to compare, and so `shouldReply` has inbound rows to label.
      await prisma.message.upsert({
        where: { id: `${id}-in` },
        create: {
          id: `${id}-in`,
          conversationId: id,
          externalMessageId: `${id}-ext-in`,
          direction: "inbound",
          messageType: "text",
          textBody: "mensagem real recebida",
          providerTimestamp: inbound,
        },
        update: {},
      });
      if (answered) {
        await prisma.message.upsert({
          where: { id: `${id}-out` },
          create: {
            id: `${id}-out`,
            conversationId: id,
            externalMessageId: `${id}-ext-out`,
            direction: "outbound",
            messageType: "text",
            textBody: "resposta real",
            providerTimestamp: new Date(inbound.getTime() + 45 * 60_000),
          },
          update: {},
        });
      }
    }
    return connection;
  }

  /** LIVE exchange the seed must not rewrite. Conversation timestamps follow SEED after seed. */
  async function liveMessageFacts() {
    const messages = await prisma.message.findMany({
      where: { conversationId: { startsWith: "live-conv-" }, origin: MESSAGE_ORIGIN_LIVE },
      orderBy: { id: "asc" },
      select: { id: true, direction: true, textBody: true, providerTimestamp: true, origin: true },
    });
    return messages;
  }

  it("survives a unit with no conversations at all", async () => {
    // A2's other arm, and it was NOT sampled until a regression proved it had to
    // be. Once identity count started following the conversations, an empty unit
    // meant an empty planned list, and three separate blocks indexed past its end
    // — the scheduled-message loop iterates the four statuses rather than the
    // owners, and two attribution rows have foreign keys to services that were
    // never created. The header claimed this axis while only ever testing the
    // populated arm; the API's own live suites caught it instead.
    const emptyUnit = await prisma.unit.create({ data: { name: `empty-${Date.now()}` } });
    const emptyUnitB = await prisma.unit.create({ data: { name: `empty-b-${Date.now()}` } });

    await expect(seed(emptyUnit.id, emptyUnitB.id)).resolves.not.toThrow();

    // Nothing was invented to fill the gap.
    const conversations = await prisma.conversation.count({
      where: { whatsappConnection: { unitId: emptyUnit.id } },
    });
    expect(conversations).toBe(0);
    const messagesOnEmpty = await prisma.message.count({
      where: { conversation: { whatsappConnection: { unitId: emptyUnit.id } } },
    });
    expect(messagesOnEmpty).toBe(0);
  }, 120_000);

  it("creates no conversations of its own, and leaves demo connections empty", async () => {
    const unit =
      (await prisma.unit.findFirst({ where: { name: "Select Lub" } })) ??
      (await prisma.unit.create({ data: { name: "Select Lub" } }));
    const unitB =
      (await prisma.unit.findFirst({ where: { name: "Select Lub 2" } })) ??
      (await prisma.unit.create({ data: { name: "Select Lub 2" } }));

    await givenRealConversations(unit.id, 24);
    const before = await counts();
    const liveBefore = await liveMessageFacts();

    await seedCatalogItems(prisma);
    await seed(unit.id, unitB.id);
    const first = await counts();

    for (const model of PROVIDER_OWNED) {
      expect(first[model], model).toBe(before[model]);
    }
    expect(first.Conversation).toBeGreaterThanOrEqual(24);
    expect(first.Message).toBeGreaterThan(before.Message ?? 0);

    const seedMessages = await prisma.message.findMany({
      where: { conversationId: { startsWith: "live-conv-" }, origin: MESSAGE_ORIGIN_SEED },
      orderBy: { id: "asc" },
      select: {
        id: true,
        conversationId: true,
        textBody: true,
        origin: true,
        direction: true,
        providerTimestamp: true,
      },
    });
    const grouped = seedMessages.reduce<Record<string, typeof seedMessages>>((acc, row) => {
      (acc[row.conversationId] ??= []).push(row);
      return acc;
    }, {});
    expect(Object.keys(grouped)).toHaveLength(24);
    for (const [id, rows] of Object.entries(grouped)) {
      expect(rows.length, id).toBeGreaterThanOrEqual(1);
      expect(rows.length, id).toBeLessThanOrEqual(20);
      expect(rows.every((row) => row.origin === MESSAGE_ORIGIN_SEED)).toBe(true);
      if (rows.length <= 4) {
        expect(rows.every((row) => !/placa/i.test(row.textBody ?? ""))).toBe(true);
      }
    }

    expect(liveBefore.every((row) => row.origin === MESSAGE_ORIGIN_LIVE)).toBe(true);
    expect(await liveMessageFacts()).toEqual(liveBefore);

    for (const [model, count] of Object.entries(first)) {
      if ((PROVIDER_OWNED as readonly string[]).includes(model)) continue;
      expect(count, model).toBeGreaterThan(0);
    }

    await seed(unit.id, unitB.id);
    // WHAT THIS CATCHES THAT NOTHING ELSE HERE DOES. The byte-exact comparison
    // of seed-owned rows below proves idempotence over the seed's OWN output.
    // This proves something different and unavailable any other way: that the
    // seed wrote nothing ANYWHERE ELSE. A stray `AttributionRule`, an extra
    // `Unit`, a `Customer` created as a side effect of some helper — every one
    // of those passes the scoped check and fails only here. That is precisely
    // the class of bug a demonstration seed acquires as it grows, so this is
    // coverage, not belt-and-braces.
    //
    // It is only meaningful on a QUIET database: it asks whether the seed
    // changed anything, so anything else writing during the window makes the
    // answer noise. That is a precondition this file is entitled to, not a flaw
    // in the assertion — and it is why `pnpm test` must not run this project
    // concurrently with the other live suites (see the root `vitest.config.ts`).
    // It was briefly narrowed on 2026-09-11 to tolerate concurrent writers and
    // then restored, with a second reviewer concurring: weakening the
    // measurement is not the same as providing the quiet it needs, and the
    // narrowed version silently gave up the out-of-scope-write check above.
    expect(await counts()).toEqual(first);
    expect(await liveMessageFacts()).toEqual(liveBefore);
    expect(
      await prisma.message.findMany({
        where: { conversationId: { startsWith: "live-conv-" }, origin: MESSAGE_ORIGIN_SEED },
        orderBy: { id: "asc" },
        select: {
          id: true,
          conversationId: true,
          textBody: true,
          origin: true,
          direction: true,
          providerTimestamp: true,
        },
      }),
    ).toEqual(seedMessages);

    // O4. Every state demonstrable, and not one of them carrying a conversation.
    const demoConnections = await prisma.whatsAppConnection.findMany({
      where: { instanceName: { startsWith: "select-lub-demo-" } },
      select: { id: true, connectionState: true, instanceName: true, _count: { select: { conversations: true } } },
    });
    expect(new Set(demoConnections.map((row) => row.connectionState)).size).toBe(4);
    expect(demoConnections.every((row) => row._count.conversations === 0)).toBe(true);
    expect(
      demoConnections.every(
        (row) => row.instanceName !== (process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc"),
      ),
    ).toBe(true);

    const scheduled = await prisma.scheduledMessage.findMany({
      where: { idempotencyKey: { startsWith: "demo-sched-" } },
      select: { status: true },
    });
    expect(new Set(scheduled.map((row) => row.status)).size).toBe(4);

    const thin = (
      await prisma.customer.findMany({
        where: { id: { startsWith: "demo-cust-" } },
        include: { emails: true, vehicles: true, services: true, phones: true },
      })
    ).filter(
      (row) =>
        row.emails.length === 0 &&
        row.street == null &&
        row.vehicles.length === 0 &&
        row.services.length === 0 &&
        Boolean(row.name) &&
        row.phones.some((phone) => phone.isPrimary),
    );
    expect(thin.length).toBeGreaterThanOrEqual(3);

    const withCarNoOs = (
      await prisma.customer.findMany({
        where: { id: { startsWith: "demo-cust-" } },
        include: { vehicles: true, services: true },
      })
    ).filter((row) => row.vehicles.length > 0 && row.services.length === 0);
    expect(withCarNoOs.length).toBeGreaterThanOrEqual(3);

    // Found by its marker rather than by id: identity count now follows the
    // conversations, so no fixed id is guaranteed to be the rich one.
    const rich = await prisma.customer.findFirst({
      where: { id: { startsWith: "demo-cust-" }, omieId: { not: null } },
      include: { vehicles: true, services: true, oilQuotes: true },
    });
    expect(rich?.street).toBeTruthy();
    expect(rich?.taxId).toBeTruthy();
    expect(rich?.omieId).toBeTruthy();
    expect(rich?.vehicles.length).toBeGreaterThanOrEqual(2);
    expect(rich?.services.length).toBeGreaterThan(0);

    // 3.1: every conversation now carries a customer, and that customer's
    // primary phone is the conversation's own number. This is the assertion the
    // whole change exists for — the number is real, the identity on it is not.
    // `Conversation.customerId` is a loose string with no foreign key, so the
    // join is done here rather than by Prisma.
    const decorated = await prisma.conversation.findMany({
      where: { id: { startsWith: "live-conv-" } },
      select: { id: true, chatKey: true, customerId: true },
    });
    expect(decorated).toHaveLength(24);
    const decoratedCustomers = await prisma.customer.findMany({
      where: { id: { in: decorated.map((row) => row.customerId).filter((id): id is string => id != null) } },
      select: { id: true, name: true, phones: { select: { normalized: true, isPrimary: true } } },
    });
    const byId = new Map(decoratedCustomers.map((row) => [row.id, row]));

    for (const row of decorated) {
      expect(row.customerId, row.id).not.toBeNull();
      const customer = byId.get(row.customerId!);
      expect(customer?.name, row.id).toEqual(expect.any(String));
      const primary = customer?.phones.find((phone) => phone.isPrimary);
      expect(primary?.normalized, row.id).toBe(row.chatKey);
    }
    // Every conversation got its OWN identity, not one shared between them.
    expect(new Set(decorated.map((row) => row.customerId)).size).toBe(24);

    // 3.2. A customer someone else attached must survive a re-seed. This is what
    // makes the seed safe to run against a deployed demo people are also using,
    // and it is the assertion that fails if the `customerId: null` scope is ever
    // dropped from the update — a change that would otherwise look harmless.
    const operatorCustomer = await prisma.customer.upsert({
      where: { id: "operator-attached" },
      create: { id: "operator-attached", name: "Attached By Hand", unitId: unit.id, origin: "crm", status: "active" },
      update: {},
    });
    await prisma.conversation.update({
      where: { id: "live-conv-01" },
      data: { customerId: operatorCustomer.id },
    });

    await seed(unit.id, unitB.id);

    const afterReseed = await prisma.conversation.findUnique({
      where: { id: "live-conv-01" },
      select: { customerId: true },
    });
    expect(afterReseed?.customerId).toBe("operator-attached");

    // 4.1/4.2. No fixed calendar date anchors the data any more. Every seeded
    // service must sit before the conversation it belongs to, and the whole set
    // must land near the real conversations rather than at a hardcoded 2026-08-31
    // — which is what made Relatórios render empty at its default period.
    // Each service is checked against ITS OWN conversation, not against this
    // file's newest fixture. The earlier version compared every service to a
    // hardcoded 2027 date and held only while these fixtures were the only
    // conversations in the unit. Once worktree databases began being cloned from
    // the pristine base they are not: 30 real conversations sit alongside these
    // 24, services land on those too, and the newest service is then near a real
    // 2026 conversation — 171 days from the fixture date. The seed was right and
    // the assertion's premise was wrong.
    const seededServices = await prisma.service.findMany({
      where: { id: { startsWith: "demo-svc-" } },
      select: { performedAt: true, customerId: true },
    });
    expect(seededServices.length).toBeGreaterThan(0);
    const conversationByCustomer = new Map(
      (
        await prisma.conversation.findMany({
          where: { customerId: { in: seededServices.map((row) => row.customerId) } },
          select: { customerId: true, firstInboundAt: true },
        })
      ).map((row) => [row.customerId!, row.firstInboundAt]),
    );

    // The bounds come from the seed's own offset rule — `daysBefore = i < 4 ?
    // i + 1 : 30 + i * 20` — not from a round number. The first few services sit
    // 1 to 4 days before their conversation and the rest are spread months back
    // on purpose, so that overdue vehicle returns exist and Relatórios has
    // non-trivial buckets. An assertion picked to fit the observed spread would
    // have accepted a fixed calendar anchor as easily as the correct behaviour.
    const distances: number[] = [];
    for (const row of seededServices) {
      expect(row.performedAt).not.toBeNull();
      const conversationAt = conversationByCustomer.get(row.customerId);
      if (!conversationAt) {
        continue;
      }
      // A service happened before the conversation about it.
      expect(row.performedAt!.getTime()).toBeLessThanOrEqual(conversationAt!.getTime());
      distances.push((conversationAt!.getTime() - row.performedAt!.getTime()) / 86_400_000);
    }
    // Guards the loop against passing vacuously: `continue` on a missing
    // conversation would make an empty check set look like a green assertion.
    expect(distances.length).toBeGreaterThan(0);
    // The `i < 4` services sit within 4 days of their own conversation, so the
    // closest service is days away wherever the conversations are.
    expect(Math.min(...distances)).toBeLessThan(7);
    // **This is the bound that catches a reintroduced fixed anchor**, verified by
    // putting one back: `Date.UTC(2026, 7, 31) - daysBefore` gave a maximum
    // distance of 883 days against a limit of 671, and the test failed here.
    //
    // The minimum did NOT catch it, which is worth stating rather than leaving
    // the reader to assume otherwise: with a fixed 2026-08-31 anchor some real
    // conversation happens to sit within a few days of that date, so `min < 7`
    // passed on the mutant. A test whose only anchor guard was the minimum would
    // have called the regression green.
    //
    // The limit is the seed's own offset rule, `30 + i * 20`, evaluated over the
    // service count — not a round number chosen to fit what was observed.
    expect(Math.max(...distances)).toBeLessThan(30 + seededServices.length * 20 + 1);

    // 3.4. All three origin classifications present, so `Conversão por origem`
    // has something to report. The fixture created every conversation as
    // UNKNOWN, so anything else here was written by the seed.
    const classified = await prisma.conversation.findMany({
      where: { id: { startsWith: "live-conv-" } },
      select: { sourceType: true, ctwaClid: true },
    });
    expect(new Set(classified.map((row) => row.sourceType))).toEqual(
      new Set(["AD", "ORGANIC", "UNKNOWN"]),
    );
    // AD rows carry the evidence that makes them AD; the others must not.
    expect(classified.filter((row) => row.sourceType === "AD").every((row) => row.ctwaClid)).toBe(true);
    expect(classified.filter((row) => row.sourceType !== "AD").every((row) => !row.ctwaClid)).toBe(true);

    // 3.5. Unanswered seeded threads carry shouldReply, which Follow-up's
    // waiting-reply section reads. The generic planner unanswered every other
    // live-conv fixture; the mix assigns one inbound-only (bare-hours) thread on
    // the oldest eligible chat in the unit — often not one of these 24 ids.
    // LIVE history import rows stay unlabeled.
    const labelled = await prisma.message.findMany({
      where: {
        origin: MESSAGE_ORIGIN_SEED,
        shouldReply: { not: null },
        conversation: { whatsappConnection: { unitId: unit.id } },
      },
      select: { direction: true, origin: true },
    });
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.every((row) => row.direction === "inbound")).toBe(true);
    expect(labelled.every((row) => row.origin === MESSAGE_ORIGIN_SEED)).toBe(true);
    for (const [id, rows] of Object.entries(grouped)) {
      const inboundOnly = rows.every((row) => row.direction === "inbound");
      if (inboundOnly) {
        const flags = await prisma.message.findMany({
          where: { conversationId: id, origin: MESSAGE_ORIGIN_SEED },
          select: { shouldReply: true },
        });
        expect(flags.every((row) => row.shouldReply === true), id).toBe(true);
      }
    }

    const seededConversations = await prisma.conversation.findMany({
      where: { id: { startsWith: "live-conv-" } },
      select: {
        id: true,
        firstInboundAt: true,
        firstOutboundAt: true,
        lastInboundAt: true,
        lastOutboundAt: true,
        lastMessageAt: true,
      },
    });
    for (const conversation of seededConversations) {
      const rows = grouped[conversation.id] ?? [];
      const inbound = rows
        .filter((row) => row.direction === "inbound")
        .map((row) => row.providerTimestamp.getTime());
      const outbound = rows
        .filter((row) => row.direction === "outbound")
        .map((row) => row.providerTimestamp.getTime());
      expect(conversation.firstInboundAt?.getTime(), conversation.id).toBe(Math.min(...inbound));
      expect(conversation.lastInboundAt?.getTime(), conversation.id).toBe(Math.max(...inbound));
      if (outbound.length === 0) {
        expect(conversation.firstOutboundAt, conversation.id).toBeNull();
      } else {
        expect(conversation.firstOutboundAt?.getTime(), conversation.id).toBe(Math.min(...outbound));
        expect(conversation.lastOutboundAt?.getTime(), conversation.id).toBe(Math.max(...outbound));
      }
    }

    const quotes = await prisma.oilQuote.findMany({
      where: { id: "demo-quote-1" },
      select: { conversationId: true },
    });
    for (const quote of quotes) {
      const conversationId = quote.conversationId;
      expect(conversationId).toEqual(expect.any(String));
      const outbound = await prisma.message.count({
        where: {
          conversationId: conversationId!,
          origin: MESSAGE_ORIGIN_SEED,
          direction: "outbound",
        },
      });
      expect(outbound).toBeGreaterThan(0);
    }

    const empUnits = await prisma.unit.findMany({ where: { name: { startsWith: "TIDSCI EMP" } } });
    expect(empUnits).toEqual([]);
  }, 120_000);
  it("leaves no verified-spec or Tecfil row for an identity no seeded vehicle has", async () => {
    // The seed upserts, and upsert never deletes. A demo row written by an older seed -
    // a fixture entry since removed, or one of the two ids earlier seeds wrote by hand -
    // would otherwise linger forever, keyed to a car the dataset no longer contains, and
    // a quote could reuse it. This asserts the seed removes what it no longer owns.
    const unit = await prisma.unit.create({ data: { name: `stale-${Date.now()}` } });
    const unitB = await prisma.unit.create({ data: { name: `stale-b-${Date.now()}` } });
    await prisma.motulCompatibility.create({
      data: {
        id: "demo-oil-spec-gone-model-1999",
        make: "Marca",
        year: 1999,
        model: "Modelo",
        version: "Versao",
        viscosity: "5W-30",
        classification: "API SN",
        consultedAt: new Date(),
      },
    });

    await seed(unit.id, unitB.id);

    expect(
      await prisma.motulCompatibility.findUnique({
        where: { id: "demo-oil-spec-gone-model-1999" },
      }),
    ).toBeNull();

    // And nothing the seed DID write points at a car it did not create.
    const specs = await prisma.motulCompatibility.findMany({
      where: { id: { startsWith: "demo-oil-spec-" } },
    });
    for (const spec of specs) {
      const owner = await prisma.vehicle.findFirst({
        where: {
          make: spec.make,
          model: spec.model,
          year: spec.year,
          version: spec.version,
        },
      });
      expect(owner, `no seeded vehicle for ${spec.make} ${spec.model} ${spec.year}`).not.toBeNull();
    }
  }, 120_000);

  it("writes the oil type on seeded lubricants, filling a row that predates the column (add-lubricant-oil-type)", async () => {
    // demo-seed "Catalog seed writes lubricant-detail for oils": a lubricant-detail written
    // before `oil_type` existed has none; re-seeding must set it (the upsert's update branch),
    // not leave it null, and must not add a second detail row.
    await prisma.catalogItem.upsert({
      where: { id: "cat-motul-8100-5w30" },
      create: { id: "cat-motul-8100-5w30", brand: "Motul", description: "8100 Eco-nergy", price: 79.9, stock: 0, active: true },
      update: {},
    });
    await prisma.catalogLubricant.upsert({
      where: { catalogItemId: "cat-motul-8100-5w30" },
      create: { catalogItemId: "cat-motul-8100-5w30", viscosity: "5W-30", classification: "", oilType: null },
      update: { oilType: null },
    });

    // The catalog half of `db:seed` (prisma/seed.ts runs it before the demo dataset).
    await seedCatalogItems(prisma);

    const motul = await prisma.catalogLubricant.findMany({ where: { catalogItemId: "cat-motul-8100-5w30" } });
    expect(motul.map((row) => row.oilType)).toEqual(["SINTETICO"]);

    // Read the seed's own ids, so a row another suite left behind cannot satisfy these.
    const seeded = await prisma.catalogLubricant.findMany({
      where: { catalogItemId: { in: CATALOG_SEED_ROWS.map((row) => row.id) }, catalogItem: { active: true } },
    });
    // Scenario "Seeded oils show more than one type at one grade".
    const typesAt5w30 = new Set(seeded.filter((row) => row.viscosity === "5W-30").map((row) => row.oilType).filter((type) => type !== null));
    expect(typesAt5w30.size).toBeGreaterThanOrEqual(2);
    // Scenario "One seeded oil has no type".
    expect(seeded.some((row) => row.oilType === null)).toBe(true);
  }, 120_000);

  it("opens exactly one OPEN return per vehicle with a service, through services' reconcile", async () => {
    // Since the cleanup after wave 5 the seed opens returns with the services
    // module's reconcileVehicleReturns, the Omie import's own apply, under
    // module_services and module_scheduling -- the scratch database is migrated
    // with the grants, as every seeding path is. Every vehicle a demo service
    // names must end with exactly one OPEN return: none leaves the Follow-up
    // return sections empty, two means a supersede was lost.
    const unit =
      (await prisma.unit.findFirst({ where: { name: "Select Lub" } })) ??
      (await prisma.unit.create({ data: { name: "Select Lub" } }));
    const unitB =
      (await prisma.unit.findFirst({ where: { name: "Select Lub 2" } })) ??
      (await prisma.unit.create({ data: { name: "Select Lub 2" } }));
    await givenRealConversations(unit.id, 24);

    await seed(unit.id, unitB.id);

    const vehicles = await prisma.service.findMany({
      where: { vehicleId: { not: null } },
      distinct: ["vehicleId"],
      select: { vehicleId: true },
    });
    // More than one, so the loop below cannot pass over an empty set.
    expect(vehicles.length).toBeGreaterThan(1);
    for (const { vehicleId } of vehicles) {
      const open = await prisma.vehicleReturn.count({ where: { vehicleId: vehicleId!, status: "OPEN" } });
      expect(open, `open returns for vehicle ${vehicleId}`).toBe(1);
    }
  }, 120_000);
});
