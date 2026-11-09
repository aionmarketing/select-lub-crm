/**
 * Deterministic fake WhatsApp threads written onto conversations that already exist.
 *
 * The seed never invents a conversation. Each eligible 1:1 thread gets `SEED`
 * messages with ids `seed:{conversationId}:{n}`. The default planner is 5–20
 * generic lines; demo passes a workshop mix via `planThread`.
 */
import type { PrismaClient } from "@prisma/client";
import { MESSAGE_ORIGIN_SEED } from "../../src/shared/message-origin.js";
import { demoInstanceNames } from "./connections.js";
import { sortDecoratable } from "./plan.js";

const MIN_THREAD_LENGTH = 5;
const MAX_THREAD_LENGTH = 20;

/** Workshop-flavoured pt-BR lines so plumbing bodies are not Latin lorem. */
const PT_BR_LINES = [
  "Oi, tudo bem?",
  "Qual o horário de hoje?",
  "Vocês abrem sábado?",
  "Preciso trocar o óleo essa semana.",
  "Pode me passar o endereço da loja?",
  "Tem vaga amanhã de manhã?",
  "Quanto fica a troca completa?",
  "Pode mandar o orçamento, por favor.",
  "Combinado, obrigado.",
  "Pode ser depois das 14h?",
  "Chego aí daqui a pouco.",
  "Ficou pronto o serviço?",
  "Pode confirmar o horário?",
  "Blz, então amanhã.",
  "Valeu, até mais.",
  "Tá certo, pode fazer.",
  "Me avisa quando ficar pronto.",
  "Pode deixar na ficha, por favor.",
  "Beleza, combinado.",
  "Obrigado pelo retorno.",
] as const;

/**
 * One planned `SEED` message. `n` is 1-based and becomes the id suffix.
 */
export type PlannedSeedMessage = {
  readonly n: number;
  readonly externalMessageId: string;
  readonly direction: "inbound" | "outbound";
  readonly textBody: string;
  readonly providerTimestamp: Date;
  readonly shouldReply: boolean | null;
};

/**
 * Inputs the thread planner needs. Cadastro-aware planners in a later change
 * add slots here; plumbing only uses id, anchor, and whether outbound exists.
 */
export type PlanSeedThreadInput = {
  readonly conversationId: string;
  readonly anchor: Date;
  readonly includeOutbound: boolean;
};

/** Builds `seed:{conversationId}:{n}` — unique per conversation, not a WhatsApp id. */
export function seedMessageExternalId(conversationId: string, n: number) {
  return `seed:${conversationId}:${n}`;
}

/**
 * Whether this conversation already has a seeded thread.
 *
 * Idempotency: any `SEED` row means skip writing more.
 *
 * @param existingSeedCount - Rows with origin SEED on this conversation.
 */
export function shouldSkipSeedThread(existingSeedCount: number) {
  return existingSeedCount > 0;
}

function hashId(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function minDate(values: Date[]) {
  return values.reduce((best, value) => (value < best ? value : best));
}

function maxDate(values: Date[]) {
  return values.reduce((best, value) => (value > best ? value : best));
}

/**
 * Conversation activity timestamps taken only from seeded messages.
 *
 * LIVE rows in the same thread are ignored, so Relatórios follow the fake exchange.
 *
 * @param messages - Seeded messages for one conversation.
 */
export function activityTimestampsFromSeed(
  messages: readonly Pick<PlannedSeedMessage, "direction" | "providerTimestamp">[],
) {
  const inbound = messages
    .filter((row) => row.direction === "inbound")
    .map((row) => row.providerTimestamp);
  const outbound = messages
    .filter((row) => row.direction === "outbound")
    .map((row) => row.providerTimestamp);
  const all = messages.map((row) => row.providerTimestamp);
  return {
    firstInboundAt: inbound.length > 0 ? minDate(inbound) : null,
    lastInboundAt: inbound.length > 0 ? maxDate(inbound) : null,
    firstOutboundAt: outbound.length > 0 ? minDate(outbound) : null,
    lastOutboundAt: outbound.length > 0 ? maxDate(outbound) : null,
    lastMessageAt: all.length > 0 ? maxDate(all) : null,
  };
}

/**
 * Plans a 5–20 message pt-BR thread. Deterministic for a given conversation id.
 *
 * @param input.conversationId - Existing conversation; never invented here.
 * @param input.anchor - Time the last seeded message lands on (usually live firstInboundAt).
 * @param input.includeOutbound - When false, every message is inbound (unanswered).
 */
export function planGenericSeedThread(input: PlanSeedThreadInput): PlannedSeedMessage[] {
  const count =
    MIN_THREAD_LENGTH + (hashId(input.conversationId) % (MAX_THREAD_LENGTH - MIN_THREAD_LENGTH + 1));
  const messages: PlannedSeedMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const n = index + 1;
    const inbound = !input.includeOutbound || index % 2 === 0;
    const direction: "inbound" | "outbound" = inbound ? "inbound" : "outbound";
    const textBody = PT_BR_LINES[hashId(`${input.conversationId}:${n}`) % PT_BR_LINES.length]!;
    messages.push({
      n,
      externalMessageId: seedMessageExternalId(input.conversationId, n),
      direction,
      textBody,
      providerTimestamp: new Date(input.anchor.getTime() - (count - n) * 3 * 60_000),
      shouldReply: direction === "inbound" && !input.includeOutbound ? true : null,
    });
  }
  return messages;
}

function isGroupJid(remoteJid: string) {
  return remoteJid.includes("@g.us");
}

/**
 * Whether this conversation may receive a `SEED` thread.
 *
 * Demo connections stay empty. Group JIDs are not 1:1 workshop chats.
 *
 * @param row.remoteJid - WhatsApp JID on the conversation.
 * @param row.whatsappConnection.instanceName - Instance that owns the chat.
 * @param demoNames - Demo instance names for this live Evolution name.
 */
export function isSeedableConversation(
  row: { remoteJid: string; whatsappConnection: { instanceName: string } },
  demoNames: ReadonlySet<string>,
) {
  return !demoNames.has(row.whatsappConnection.instanceName) && !isGroupJid(row.remoteJid);
}

/**
 * Inserts `SEED` threads and rewrites activity timestamps from those rows only.
 *
 * Skips demo connections (they must stay empty) and group JIDs. If any `SEED`
 * row already exists for a conversation, that conversation is not given more
 * messages. Timestamps are always recomputed from whatever `SEED` rows are there.
 *
 * @param prisma - Shared Prisma client.
 * @param input.unitId - Unit whose conversations are decorated.
 * @param input.liveInstanceName - Used only to know which instance names are demo.
 * @param input.planThread - Defaults to {@link planGenericSeedThread}; mix replaces this.
 */
export async function seedFakeHistory(
  prisma: PrismaClient,
  input: {
    unitId: string;
    liveInstanceName: string;
    planThread?: (plan: PlanSeedThreadInput) => PlannedSeedMessage[];
  },
) {
  const planThread = input.planThread ?? planGenericSeedThread;
  const demoNames = new Set(demoInstanceNames(input.liveInstanceName));
  const conversations = sortDecoratable(
    await prisma.conversation.findMany({
      where: { whatsappConnection: { unitId: input.unitId } },
      select: {
        id: true,
        firstInboundAt: true,
        firstOutboundAt: true,
        startedAt: true,
        remoteJid: true,
        whatsappConnection: { select: { instanceName: true } },
      },
    }),
  ).filter((row) => isSeedableConversation(row, demoNames));

  for (const [index, conversation] of conversations.entries()) {
    const existingSeedCount = await prisma.message.count({
      where: { conversationId: conversation.id, origin: MESSAGE_ORIGIN_SEED },
    });
    if (!shouldSkipSeedThread(existingSeedCount)) {
      const anchor = conversation.firstInboundAt ?? conversation.startedAt;
      const planned = planThread({
        conversationId: conversation.id,
        anchor,
        includeOutbound: index % 2 === 0,
      });
      if (planned.length > 0) {
        await prisma.message.createMany({
          data: planned.map((row) => ({
            id: row.externalMessageId,
            conversationId: conversation.id,
            externalMessageId: row.externalMessageId,
            direction: row.direction,
            messageType: "text",
            textBody: row.textBody,
            providerTimestamp: row.providerTimestamp,
            origin: MESSAGE_ORIGIN_SEED,
            shouldReply: row.shouldReply,
          })),
        });
      }
    }

    const seedRows = await prisma.message.findMany({
      where: { conversationId: conversation.id, origin: MESSAGE_ORIGIN_SEED },
      select: { direction: true, providerTimestamp: true },
    });
    if (seedRows.length === 0) {
      continue;
    }
    const activity = activityTimestampsFromSeed(
      seedRows.map((row) => ({
        direction: row.direction as "inbound" | "outbound",
        providerTimestamp: row.providerTimestamp,
      })),
    );
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        firstInboundAt: activity.firstInboundAt,
        lastInboundAt: activity.lastInboundAt,
        firstOutboundAt: activity.firstOutboundAt,
        lastOutboundAt: activity.lastOutboundAt,
        lastMessageAt: activity.lastMessageAt ?? undefined,
      },
    });
  }
}
