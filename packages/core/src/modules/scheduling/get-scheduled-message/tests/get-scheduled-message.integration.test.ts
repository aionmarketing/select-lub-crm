/**
 * Test design (testing-strategy) — scheduling / get-scheduled-message
 *
 * Module role: `module_scheduling`. The one read — `scheduled_message` joined to
 * `template` (conversations'), `user` (accounts') and `service` (services'),
 * all `readableBy` — runs in `db.tx("scheduling", …)`.
 *
 * Moved from `apps/api/src/scheduled.detail.route.test.ts`, all eight cases,
 * assertions unchanged. The another-loja case used to make the caller a member
 * of both lojas so the hook would let it through; here the caller is stated,
 * scoped to the first loja, and the 404 is the slice's join exactly as before.
 *
 * SUT: `GET /scheduled-messages/:id`, through `buildSliceApp` with this slice's
 *   route only, inside one rolling-back transaction per test. No probe: the
 *   detail read never consults the channel.
 *
 * Oracle: `scheduled-messages` delta of `align-shipped-ui-to-revised-canvas`,
 *   requirement "One scheduled message is readable in detail" — frozen text,
 *   scheduled instant with its zone, status, template, originating service,
 *   creator, and the recorded error when falhou. The resolved-label shape
 *   (names beside ids) is the user's decision of 2026-09-03.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   F1 — a dangling `templateId` is unrepresentable: the foreign key is
 *     `ON DELETE SET NULL`, so after the template goes both `templateId` and
 *     `templateName` are null.
 *   F2 — `createdByName: null` is unreachable: `created_by_user_id` and
 *     `user.name` are NOT NULL, so the creator always resolves.
 *   F3 — unit scoping is the join `conversation → whatsappConnection → unitId`;
 *     a row with no conversation and a row in another loja both miss it.
 *
 * Axes
 *   A1 status — FAILED carrying a reason / SCHEDULED carrying none
 *   A2 origin service — linked / not linked
 *   A3 template — linked and present / linked then deleted / not linked
 *   A5 unit — caller's loja owns the conversation / another loja does
 *   A6 addressability — id exists / id unknown / row has no conversation
 *   A7 service date — `performedAt` set / null
 *
 * Outputs
 *   O1 200 with text, scheduledAt and timeZone; O2 lastError with the reason;
 *   O3 lastError null; O4 originatingService named; O5 originatingService null;
 *   O6 templateName / createdByName resolved; O7 templateName null with
 *   templateId null; O8 404
 *
 * Sampled cells
 *   full row, everything linked    | A1 SCHEDULED A2 A3 A7 | O1 O3 O4 O6
 *   falhou row                     | A1 FAILED             | O2
 *   bare row, nothing linked       | A2 no A3 no           | O5 O3 + creator named
 *   service with no performedAt    | A2 linked A7 null     | O4 with null date
 *   template deleted after the row | A3 deleted            | O7
 *   another loja's message         | A5 other              | O8
 *   unknown id                     | A6 unknown            | O8
 *   message with no conversation   | A6 no conversation    | O8
 *
 * Decision / branch map
 *   handler `!unitId`              contract-hidden — the hook 403s first
 *   `findFirst` miss               T the three 404 its; F the five 200 its
 *   `row.template?.name ?? null`   T bare-row and deleted-template; F full-row
 *   `row.createdByUser?.name ?? null` always F — see F2
 *   `row.service ?? null`          T bare-row; F full-row, null-date
 *   `performedAt ? iso : null`     T full-row; F null-date
 *
 * Out of scope: create / cancel / list / suggest (their slices); the rail
 *   drill-in in apps/web.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { scheduledMessageDetailSchema } from "../../contracts/http.js";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const CREATOR_NAME = "Ana Atendente";

const db = () => prisma as PrismaClient;

/** One loja, its connection, one conversation on it, and the named attendant. */
async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const user = await seedUser(tx, { units: [unit.id], name: CREATOR_NAME });
  return { unitId: unit.id, userId: user.id, conversationId: conversation.id };
}

/** This slice alone, as the scope's attendant. */
function appOn(tx: DbClient, scope: { unitId: string; userId: string }) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "scheduling", "get-scheduled-message", route),
    caller: { userId: scope.userId, unitId: scope.unitId },
  });
}

async function insertSchedule(
  tx: DbClient,
  input: {
    conversationId: string | null;
    userId: string;
    frozenText?: string;
    scheduledAt?: Date;
    status?: string;
    lastError?: string | null;
    serviceId?: string | null;
    templateId?: string | null;
  },
) {
  return tx.scheduledMessage.create({
    data: {
      conversationId: input.conversationId,
      serviceId: input.serviceId ?? null,
      templateId: input.templateId ?? null,
      frozenText: input.frozenText ?? "Olá",
      scheduledAt: input.scheduledAt ?? new Date("2099-09-15T12:00:00.000Z"),
      status: input.status ?? "SCHEDULED",
      lastError: input.lastError ?? null,
      idempotencyKey: randomUUID(),
      createdByUserId: input.userId,
    },
    select: { id: true },
  });
}

/** A service in `unitId`, with its own customer, that a schedule can name. */
async function insertService(
  tx: DbClient,
  input: { unitId: string; performedAt: Date | null; omieId: string | null; description: string | null },
) {
  const customer = await tx.customer.create({
    data: { origin: "crm", status: "active", name: "Maria" },
    select: { id: true },
  });
  return tx.service.create({
    data: {
      customerId: customer.id,
      unitId: input.unitId,
      origin: "crm",
      performedAt: input.performedAt,
      omieId: input.omieId,
      description: input.description,
    },
    select: { id: true },
  });
}

function insertTemplate(tx: DbClient, unitId: string, name: string) {
  return tx.template.create({
    data: { unitId, name, text: "Olá {{nome}}", allowedVariables: ["nome"] },
    select: { id: true },
  });
}

describeWithDatabase("GET /scheduled-messages/:id", () => {
  it("carries the frozen text, the scheduled instant and its zone", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, {
        unitId: scope.unitId,
        performedAt: new Date("2026-03-10T13:00:00.000Z"),
        omieId: "OS-4417",
        description: "Troca de óleo",
      });
      const template = await insertTemplate(tx, scope.unitId, "Lembrete de retorno");
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
        templateId: template.id,
        frozenText: "Olá Maria, seu retorno está próximo",
        scheduledAt: new Date("2099-09-15T12:00:00.000Z"),
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(200);
        const detail = scheduledMessageDetailSchema.parse(response.json());
        expect(detail.text).toBe("Olá Maria, seu retorno está próximo");
        expect(detail.scheduledAt).toBe("2099-09-15T12:00:00.000Z");
        expect(detail.timeZone).toBe("America/Sao_Paulo");
        expect(detail.status).toBe("SCHEDULED");
        expect(detail.lastError).toBeNull();
        expect(detail.templateName).toBe("Lembrete de retorno");
        expect(detail.createdByName).toBe(CREATOR_NAME);
        expect(detail.originatingService).toEqual({
          id: service.id,
          omieId: "OS-4417",
          description: "Troca de óleo",
          performedAt: "2026-03-10T13:00:00.000Z",
        });
      } finally {
        await app.close();
      }
    }));

  it("carries the recorded error when the message falhou", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const reason = "Evolution respondeu 463 (NackCallerReachoutTimelocked)";
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        status: "FAILED",
        lastError: reason,
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe("FAILED");
        expect(response.json().lastError).toBe(reason);
      } finally {
        await app.close();
      }
    }));

  it("returns null, not an absent field, for every link the message does not have", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const row = await insertSchedule(tx, { conversationId: scope.conversationId, userId: scope.userId });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(200);
        const detail = scheduledMessageDetailSchema.parse(response.json());
        expect(detail.originatingService).toBeNull();
        expect(detail.templateName).toBeNull();
        expect(detail.lastError).toBeNull();
        // NOT null: every schedule has a creator and every creator has a name,
        // both NOT NULL in the schema (F2).
        expect(detail.createdByName).toBe(CREATOR_NAME);
      } finally {
        await app.close();
      }
    }));

  it("names an originating service that carries no performed date", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, {
        unitId: scope.unitId,
        performedAt: null,
        omieId: null,
        description: null,
      });
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        serviceId: service.id,
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(200);
        expect(response.json().originatingService).toEqual({
          id: service.id,
          omieId: null,
          description: null,
          performedAt: null,
        });
      } finally {
        await app.close();
      }
    }));

  it("drops the template link when the template is deleted, naming no template", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const template = await insertTemplate(tx, scope.unitId, "Some some");
      const row = await insertSchedule(tx, {
        conversationId: scope.conversationId,
        userId: scope.userId,
        templateId: template.id,
      });
      const app = await appOn(tx, scope);
      try {
        // Precondition: the link resolves while the template is there.
        const before = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });
        expect(before.json().templateName).toBe("Some some");

        await tx.template.delete({ where: { id: template.id } });

        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(200);
        // Both null: the foreign key is ON DELETE SET NULL, so the id cannot
        // outlive the row it points at (F1).
        expect(response.json().templateId).toBeNull();
        expect(response.json().templateName).toBeNull();
      } finally {
        await app.close();
      }
    }));

  it("answers 404 for a message whose conversation belongs to another loja", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const otherUnit = await seedUnit(tx);
      const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
      const otherConversation = await seedConversation(tx, { connectionId: otherConnection.id });
      const row = await insertSchedule(tx, {
        conversationId: otherConversation.id,
        userId: scope.userId,
        frozenText: "Olá",
      });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain("Olá");
      } finally {
        await app.close();
      }
    }));

  it("answers 404 for an id no message carries", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: "/scheduled-messages/nao-existe" });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("answers 404 for a message with no conversation, which no loja can claim", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const row = await insertSchedule(tx, { conversationId: null, userId: scope.userId });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({ method: "GET", url: `/scheduled-messages/${row.id}` });

        // The join has nothing to join to, so the one findFirst misses (F3).
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));
});
