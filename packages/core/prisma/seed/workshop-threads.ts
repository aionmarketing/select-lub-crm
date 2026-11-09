/**
 * Plans workshop `SEED` bodies for the seedable conversations in a unit.
 *
 * Cadastro identities must already have been planned (faker reset consumed).
 * This continues that same faker stream for distractors so two equal batches
 * yield identical bodies.
 */
import { sliceHasVehicle, type PlannedCustomer } from "./plan.js";
import { faker } from "./faker.js";
import {
  assignThreadArchetypes,
  type ThreadArchetype,
  type ThreadAssignment,
  type ThreadDecoratable,
} from "./thread-archetypes.js";
import {
  blurbForArchetype,
  drawTrapDistractors,
  planWorkshopSeedThread,
  type StoredCadastro,
} from "./thread-templates.js";
import type { PlannedSeedMessage } from "./history.js";
import type { ThreadMixRow } from "./thread-mix-summary.js";

/** Conversation fields the workshop planner needs, including the real chat key. */
export type WorkshopConversation = ThreadDecoratable & {
  readonly chatKey: string;
  readonly startedAt: Date;
};

export type PlannedWorkshopBatch = {
  readonly assignment: ThreadAssignment;
  readonly plannedByConversation: ReadonlyMap<string, PlannedSeedMessage[]>;
  readonly summaryThreads: readonly ThreadMixRow[];
};

function storedFromPlanned(
  planned: PlannedCustomer | undefined,
  conversation: WorkshopConversation,
  index: number,
): StoredCadastro {
  const slice = planned?.slice ?? "thin";
  const hasVehicle = planned !== undefined && sliceHasVehicle(slice);
  const rich = slice === "rich";
  return {
    name: planned?.name ?? null,
    plate: hasVehicle ? (planned?.plate ?? null) : null,
    make: hasVehicle ? "Volkswagen" : null,
    model: hasVehicle ? "Polo" : null,
    year: hasVehicle ? 2018 + (index % 6) : null,
    street: rich ? "Rua Conceição" : null,
    extraMake: rich ? "Fiat" : null,
    extraModel: rich ? "Argo" : null,
    extraYear: rich ? 2021 : null,
    chatKey: conversation.chatKey,
  };
}

function stackedArchetypes(
  archetype: ThreadArchetype,
  conversationId: string,
  assignment: ThreadAssignment,
): string[] {
  const labels: string[] = [archetype];
  if (assignment.cleanConversationId === conversationId) {
    labels.push("clean");
  }
  if (assignment.mistypedConversationId === conversationId) {
    labels.push("mistyped");
  }
  return labels;
}

/**
 * Assigns archetypes and renders every seedable conversation's `SEED` thread.
 *
 * Pair customers by conversation id from the original sorted batch, not by
 * position after activity timestamps are rewritten.
 *
 * @param input.conversations - Seedable 1:1 chats, already sorted.
 * @param input.customerByConversationId - Identities from `planDemoCustomers`.
 * @param input.customerIndexByConversationId - Index used for vehicle year.
 */
export function planWorkshopSeedBatch(input: {
  conversations: readonly WorkshopConversation[];
  customerByConversationId: ReadonlyMap<string, PlannedCustomer>;
  customerIndexByConversationId: ReadonlyMap<string, number>;
}): PlannedWorkshopBatch {
  const assignment = assignThreadArchetypes(input.conversations);
  const plannedByConversation = new Map<string, PlannedSeedMessage[]>();
  const summaryThreads: ThreadMixRow[] = [];

  for (const conversation of input.conversations) {
    const archetype = assignment.byConversation.get(conversation.id);
    if (archetype === undefined) {
      continue;
    }
    const plannedCustomer = input.customerByConversationId.get(conversation.id);
    const index = input.customerIndexByConversationId.get(conversation.id) ?? 0;
    const stored = storedFromPlanned(plannedCustomer, conversation, index);
    const distractors = drawTrapDistractors(stored, faker);
    const planned = planWorkshopSeedThread({
      conversationId: conversation.id,
      anchor: conversation.firstInboundAt ?? conversation.startedAt,
      archetype,
      stored,
      distractors,
      applyTypos: assignment.mistypedConversationId === conversation.id,
    });
    plannedByConversation.set(conversation.id, planned);
    summaryThreads.push({
      displayName: plannedCustomer?.name ?? "pré-cadastro",
      blurb: blurbForArchetype(archetype),
      seedCount: planned.length,
      archetypes: stackedArchetypes(archetype, conversation.id, assignment),
    });
  }

  return { assignment, plannedByConversation, summaryThreads };
}
