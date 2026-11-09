/**
 * Ensures the live conversation has a free service for Programar mensagem.
 *
 * HTTP services routes are GET-only; when none is free this upserts a CRM-local
 * OS via Prisma (same pattern as `seed-e2e.ts`), then the spec reads it back
 * through `GET /conversations/:id/services`.
 */
import { PrismaClient } from "@select-lub/core/db";
import { LIVE_SCHEDULE_SERVICE_ID, liveScheduleServiceId } from "./ids.js";
import type { LiveScheduleConversation } from "./gate.js";

/**
 * Returns a service id on `conversation` that has no occupying (non-reminder,
 * non-cancelled) scheduled message, creating `LIVE_SCHEDULE_SERVICE_ID` if needed.
 *
 * @param conversation - Gate-ready live conversation
 * @param runId - Short unique token used when every existing OS is occupied
 * @returns Service id to pass to `programarFree`
 * @throws When the conversation has no customer to hang an OS on and one cannot be created
 */
export async function ensureFreeLiveService(
  conversation: LiveScheduleConversation,
  runId: string,
): Promise<string> {
  const prisma = new PrismaClient();
  try {
    let customerId = conversation.customerId;
    if (!customerId) {
      const created = await prisma.customer.create({
        data: {
          unitId: conversation.unitId,
          origin: "crm",
          status: "active",
          country: "BR",
          name: "Live schedule dest",
        },
      });
      customerId = created.id;
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { customerId },
      });
    }

    const occupying = await prisma.scheduledMessage.findMany({
      where: {
        conversationId: conversation.id,
        status: { not: "CANCELLED" },
        returnReminderMessageId: null,
        serviceId: { not: null },
      },
      select: { serviceId: true },
    });
    const occupied = new Set(occupying.map((row) => row.serviceId).filter((id): id is string => id !== null));

    const existing = await prisma.service.findMany({
      where: { customerId },
      select: { id: true },
    });
    const free = existing.find((row) => !occupied.has(row.id));
    if (free) {
      return free.id;
    }

    // A finished run leaves its schedule `SENT`, which occupies its OS permanently,
    // so fall back to a run-unique id instead of failing the second run.
    const serviceId = occupied.has(LIVE_SCHEDULE_SERVICE_ID)
      ? liveScheduleServiceId(runId)
      : LIVE_SCHEDULE_SERVICE_ID;
    await prisma.service.upsert({
      where: { id: serviceId },
      create: {
        id: serviceId,
        customerId,
        unitId: conversation.unitId,
        performedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        description: "Troca de óleo live-schedule",
        kind: "oil",
        status: "done",
        origin: "crm",
      },
      update: {
        customerId,
        unitId: conversation.unitId,
      },
    });
    if (occupied.has(serviceId)) {
      throw new Error(`live schedule service ${serviceId} is occupied; cancel leftover rows`);
    }
    return serviceId;
  } finally {
    await prisma.$disconnect();
  }
}
