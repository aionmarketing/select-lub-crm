/**
 * Reading a reminder message back in the shape every reminder route answers
 * with. Moved from `apps/api/src/return-reminders/prisma.ts` (`readMessage`),
 * unchanged.
 */
import type { DbClient } from "../../../kernel/db.js";
import type { ReturnReminderMessage } from "../contracts/http.js";
import { toScheduleDto } from "./schedule-dto.js";

/**
 * Reads one reminder message with every scheduled row, sent ones included.
 *
 * Cancelled rows travel too. The screen drops them, but a second fetch to learn
 * what vanished would be worse than sending rows it ignores.
 *
 * @param tx - A client under `module_scheduling`.
 * @param reminderMessageId - The message; it must exist.
 * @returns The DTO, rows ordered by instant.
 */
export async function readReminderMessage(
  tx: DbClient,
  reminderMessageId: string,
): Promise<ReturnReminderMessage> {
  const row = await tx.returnReminderMessage.findUniqueOrThrow({
    where: { id: reminderMessageId },
    include: { scheduledMessages: { orderBy: { scheduledAt: "asc" } } },
  });
  return {
    reminderMessageId: row.id,
    vehicleReturnId: row.vehicleReturnId,
    bodyTemplate: row.bodyTemplate,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    // A reminder row never carries a suggestion source; the old adapter forced
    // null here, and so does this.
    scheduledMessages: row.scheduledMessages.map((message) =>
      toScheduleDto({ ...message, suggestionSource: null }),
    ),
  };
}
