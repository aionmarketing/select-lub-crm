/**
 * Assigns workshop thread archetypes onto the same sorted batch as conversation roles.
 *
 * Constrained archetypes (true-positive and vehicle traps need a stored vehicle)
 * fill first. Surplus conversations cycle leftover scripts. Unfilled roles are
 * reported, never doubled onto one conversation.
 */
import { sortDecoratable, type DecoratableConversation } from "./plan.js";

/** Primary workshop mix plus leftover scripts for surplus conversations. */
export type ThreadArchetype =
  | "bareHours"
  | "truePositive"
  | "formerVehicle"
  | "familyCar"
  | "thirdPartyPlate"
  | "someoneElseNamePhone"
  | "destinationNotHome"
  | "otherShopQuote"
  | "leftoverScheduling"
  | "leftoverReturn"
  | "leftoverPriceCheck";

const PRIMARY_ORDER: readonly ThreadArchetype[] = [
  "truePositive",
  "formerVehicle",
  "familyCar",
  "bareHours",
  "thirdPartyPlate",
  "someoneElseNamePhone",
  "destinationNotHome",
  "otherShopQuote",
];

const LEFTOVER_CYCLE: readonly ThreadArchetype[] = [
  "leftoverScheduling",
  "leftoverReturn",
  "leftoverPriceCheck",
];

/** Conversation fields thread assignment reads, including whether a vehicle will be stored. */
export type ThreadDecoratable = DecoratableConversation & {
  readonly hasVehicle: boolean;
};

export type ThreadAssignment = {
  /** Conversation id → the one primary (or leftover) archetype it carries. */
  readonly byConversation: ReadonlyMap<string, ThreadArchetype>;
  readonly unfilled: readonly { readonly archetype: ThreadArchetype; readonly reason: string }[];
  /** Conversation that receives the typo transform. Absent when the batch is empty. */
  readonly mistypedConversationId: string | undefined;
  /** Conversation left in clean Portuguese. Absent when the batch has fewer than two. */
  readonly cleanConversationId: string | undefined;
};

function needsVehicle(archetype: ThreadArchetype) {
  return archetype === "truePositive" || archetype === "formerVehicle" || archetype === "familyCar";
}

function canCarry(archetype: ThreadArchetype, conversation: ThreadDecoratable) {
  return needsVehicle(archetype) ? conversation.hasVehicle : true;
}

function whyUnfilled(archetype: ThreadArchetype, batchSize: number) {
  if (batchSize === 0) {
    return "there are no conversations to decorate";
  }
  if (needsVehicle(archetype)) {
    return "no unused conversation in this batch has a stored vehicle";
  }
  return "the batch has fewer conversations than there are archetypes";
}

/**
 * Assigns each listed archetype to at most one conversation, then leftover scripts.
 *
 * Same ordering as {@link sortDecoratable}. A conversation is never given two
 * primary archetypes. Register stacking is recorded separately.
 *
 * @param conversations - The batch about to receive `SEED` threads.
 */
export function assignThreadArchetypes(
  conversations: readonly ThreadDecoratable[],
): ThreadAssignment {
  const ordered = sortDecoratable(conversations);
  const byConversation = new Map<string, ThreadArchetype>();
  const unfilled: { archetype: ThreadArchetype; reason: string }[] = [];
  const taken = new Set<string>();

  for (const archetype of PRIMARY_ORDER) {
    const pick = ordered.find(
      (conversation) => !taken.has(conversation.id) && canCarry(archetype, conversation),
    );
    if (pick === undefined) {
      unfilled.push({ archetype, reason: whyUnfilled(archetype, ordered.length) });
      continue;
    }
    taken.add(pick.id);
    byConversation.set(pick.id, archetype);
  }

  let leftoverIndex = 0;
  for (const conversation of ordered) {
    if (taken.has(conversation.id)) {
      continue;
    }
    const leftover = LEFTOVER_CYCLE[leftoverIndex % LEFTOVER_CYCLE.length]!;
    leftoverIndex += 1;
    taken.add(conversation.id);
    byConversation.set(conversation.id, leftover);
  }

  const ids = ordered.map((row) => row.id);
  const mistypedConversationId = ids.at(-1);
  const cleanConversationId = ids.length >= 2 ? ids[0] : undefined;

  return { byConversation, unfilled, mistypedConversationId, cleanConversationId };
}

/** Archetypes that occupy one conversation each before leftovers. */
export const PRIMARY_THREAD_ARCHETYPES = PRIMARY_ORDER;

/**
 * Whether this archetype's `SEED` thread includes an outbound message.
 *
 * Bare-hours stays inbound-only so `assignConversationRoles` cannot put a quote
 * on it. Sending a quote is an outbound message.
 *
 * @param archetype - The thread shape assigned to a conversation.
 */
export function threadHasSeededOutbound(archetype: ThreadArchetype) {
  return archetype !== "bareHours";
}
