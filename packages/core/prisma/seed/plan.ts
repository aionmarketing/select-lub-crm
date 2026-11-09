/**
 * Deterministic demo values (names, phones, plates) used by the seed and by tests.
 */
import { resetDemoFaker } from "./faker.js";

/** Completeness of a seeded Cliente ficha. Pré-cadastro chats have no customer row. */
export type DemoCustomerSlice = "thin" | "partial" | "active" | "rich";

/**
 * A generated identity, to be attached to one real conversation.
 *
 * There is deliberately no phone. A decorated customer's primary phone is the
 * **conversation's own number**, which is real — the number is what identifies a
 * person, and it is the one thing here that is not invented. `taxId` is separate
 * for the same reason: it used to reuse the faker phone digits, which now would
 * mean copying a real number into a document field.
 */
export type PlannedCustomer = {
  id: string;
  name: string;
  taxId: string;
  email: string | null;
  plate: string | null;
  slice: DemoCustomerSlice;
};

/** Share of the mix each slice takes, at any volume. Active is the remainder. */
const SLICE_SHARE = { rich: 0.05, thin: 0.2, partial: 0.2 } as const;

/**
 * Assigns the workshop-mix slice for a 0-based customer index in a list of `total`.
 *
 * Proportional rather than pinned to fixed indices, because the list is now as
 * long as there are conversations to decorate rather than always 20. The shares
 * are the ones the fixed layout had at 20 (1 rich, 4 thin, 4 partial, 11 active),
 * so a small dataset looks as it always did and a large one keeps the same shape
 * instead of becoming almost entirely `active`.
 *
 * Each share floors at one, so every slice stays demonstrable even on a handful
 * of conversations — a demo missing the thin-ficha state is a demo that cannot
 * show pré-cadastro.
 *
 * @param index - 0-based position in the planned list.
 * @param total - How many customers are being planned.
 */
export function sliceForIndex(index: number, total: number): DemoCustomerSlice {
  const rich = Math.max(1, Math.round(total * SLICE_SHARE.rich));
  const thin = Math.max(1, Math.round(total * SLICE_SHARE.thin));
  const partial = Math.max(1, Math.round(total * SLICE_SHARE.partial));
  if (index < rich) {
    return "rich";
  }
  if (index < rich + thin) {
    return "thin";
  }
  if (index < rich + thin + partial) {
    return "partial";
  }
  return "active";
}

/** Whether this slice gets a vehicle row (thin fichas do not). */
export function sliceHasVehicle(slice: DemoCustomerSlice) {
  return slice !== "thin";
}

/** Whether this slice gets an Omie-origin service. */
export function sliceHasService(slice: DemoCustomerSlice) {
  return slice === "active" || slice === "rich";
}

/**
 * Builds one generated identity per conversation to decorate.
 *
 * Deterministic: calling it twice with the same `count` yields the same list,
 * because the faker seed is reset first. Volume follows the conversations rather
 * than a fixed 20 — with more conversations it plans more identities, and with
 * none it plans none.
 *
 * @param count - How many conversations have no customer yet.
 * @returns `count` identities carrying the workshop completeness mix.
 */
export function planDemoCustomers(count: number): PlannedCustomer[] {
  const faker = resetDemoFaker();
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const id = `demo-cust-${String(index + 1).padStart(2, "0")}`;
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    const email = faker.internet.email({ firstName: first, lastName: last }).toLowerCase();
    const plate = faker.string.alphanumeric({ length: 7, casing: "upper" });
    const slice = sliceForIndex(index, count);
    return {
      id,
      name: `${first} ${last}`,
      taxId: faker.string.numeric(11),
      email: slice === "thin" ? null : email,
      plate: sliceHasVehicle(slice) ? plate : null,
      slice,
    };
  });
}

/** The fields role assignment reads off a conversation the seed did not create. */
export type DecoratableConversation = {
  readonly id: string;
  readonly firstInboundAt: Date | null;
  readonly firstOutboundAt: Date | null;
};

/**
 * One ordering for the batch, shared by role assignment and identity pairing.
 *
 * Exported so both read the same list. If they sorted independently the two
 * could drift, and the conversation carrying the quote would stop being the one
 * whose identity the seed thought it was decorating — a mismatch nothing would
 * report, because both halves would still look internally consistent.
 *
 * Total and stable: inbound time ascending, conversations with no inbound
 * timestamp last, ties broken on id.
 */
export function sortDecoratable<T extends DecoratableConversation>(
  conversations: readonly T[],
): T[] {
  return [...conversations].sort((a, b) => {
    const at = a.firstInboundAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.firstInboundAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return at === bt ? a.id.localeCompare(b.id) : at - bt;
  });
}

/**
 * A demo surface that must hang off exactly one conversation.
 *
 * There is deliberately no `followUpClosed` role. The closed Follow-up entry is
 * an `unansweredQuotes` row anchored on the quote id, so it belongs on the
 * quote's own conversation — a closed unanswered-quote entry pointing at a
 * thread with no quote is the kind of contradiction this seed avoids. A role
 * nothing consumes would also report as permanently unfilled and read as a bug.
 */
export type ConversationRole = "quote" | "prefillPending" | "prefillFailed" | "tagRemoved";

export type RoleAssignment = {
  /** Role → the conversation id that carries it. A role absent here is unfilled. */
  readonly byRole: ReadonlyMap<ConversationRole, string>;
  /** Roles no conversation could carry, each with why, so the seed can say so. */
  readonly unfilled: readonly { readonly role: ConversationRole; readonly reason: string }[];
};

/**
 * Order roles are offered conversations in. Fixed, so assignment is reproducible.
 *
 * `quote` is first because it is the only role with a data constraint: offering it
 * last would let the unconstrained roles consume the few conversations that have a
 * reply, and leave it unfilled on data that could have carried it.
 */
const ROLE_ORDER: readonly ConversationRole[] = [
  "quote",
  "prefillFailed",
  "prefillPending",
  "tagRemoved",
];

/**
 * Whether a conversation may carry a role, given what happened on its seeded thread.
 *
 * Only `quote` is constrained. Sending a quote IS an outbound message, so the seed
 * writes `firstOutboundAt` from `SEED` timestamps and then assigns this role to a
 * conversation whose seeded thread includes a reply.
 */
function conversationCanCarry(role: ConversationRole, conversation: DecoratableConversation) {
  return role === "quote" ? conversation.firstOutboundAt !== null : true;
}

/**
 * Why a role could not be filled, in terms an operator can act on.
 *
 * The empty-batch case is separated because the constrained explanation is
 * actively misleading there: told that "no conversation has an outbound
 * message" when the database holds no conversations at all, a reader would go
 * looking at reply activity instead of at whether any traffic ever arrived.
 */
function whyUnfilled(role: ConversationRole, batchSize: number): string {
  if (batchSize === 0) {
    return "there are no conversations without a customer to decorate";
  }
  return role === "quote"
    ? "no conversation in this batch has an outbound message, and a quote may not sit on one that records no reply"
    : "the batch has fewer conversations than there are roles";
}

/**
 * Assign each demo role to one conversation from the batch about to be decorated.
 *
 * Sorted by `firstInboundAt` and assigned by position. Sorting is total and stable:
 * conversations with no inbound timestamp sort last, and ties break on id, so the
 * same batch yields the same assignment every run.
 *
 * Positional assignment is safe here **because the caller only ever passes
 * conversations that have no customer**. Already-decorated conversations are
 * excluded from the batch, so roles are only assigned to new arrivals and an
 * existing conversation's role can never shift under it.
 *
 * A role no conversation can carry is left out of `byRole` and reported in
 * `unfilled`. The seed continues — failing would block `db:seed` on a database
 * whose conversations are simply quiet, and forcing the role would produce the
 * contradiction `demo-seed` exists to prevent.
 *
 * @param conversations - The batch being decorated; conversations with no customer.
 * @returns Which conversation carries each role, and which roles nothing could.
 */
export function assignConversationRoles(
  conversations: readonly DecoratableConversation[],
): RoleAssignment {
  const ordered = sortDecoratable(conversations);

  const byRole = new Map<ConversationRole, string>();
  const unfilled: { role: ConversationRole; reason: string }[] = [];
  const taken = new Set<string>();

  for (const role of ROLE_ORDER) {
    const pick = ordered.find(
      (conversation) => !taken.has(conversation.id) && conversationCanCarry(role, conversation),
    );
    if (pick === undefined) {
      unfilled.push({ role, reason: whyUnfilled(role, ordered.length) });
      continue;
    }
    taken.add(pick.id);
    byRole.set(role, pick.id);
  }

  return { byRole, unfilled };
}
