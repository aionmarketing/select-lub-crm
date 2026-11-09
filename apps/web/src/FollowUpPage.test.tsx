/**
 * Test design (testing-strategy)
 *
 * SUT: FollowUpPage rendered in AppProviders with MSW; query retry false.
 *
 * Oracle: follow-up (align-shipped-ui-to-pdf-artboards delta) — "the name SHALL
 *   sit beside the page title as a chip", "a count card SHALL print its
 *   section's name as an uppercase caption label above the count", "each
 *   rendered section SHALL be a heading placed above one card, the heading
 *   carrying the section's ordering as a subtitle", "Every entry that has a
 *   conversation SHALL offer Abrir conversa as a sentence-case pill" with its
 *   scenario "A return without a conversation has no Abrir conversa" (the
 *   delta amended on 2026-09-05 so the wording matches what a nullable
 *   `conversationId` can honestly offer), "an archive action drawn as an ×
 *   mark carrying an accessible name", "row actions SHALL sit beside
 *   the row's content ... and MUST NOT be pushed to the far edge of the card",
 *   "a section whose closed set is not empty SHALL end its card with a foot
 *   strip stating how many entries are archived ... on one line, with a Ver os
 *   arquivados control at its end", "a section with nothing archived SHALL draw
 *   no strip", "there is no screen-level closed view", "archiving is worded
 *   with arquivar / arquivados / desarquivar, and neither fechar nor ocultar
 *   names it".
 *
 *   Two owner decisions from the 2026-09-05 sign-off that the specs do not
 *   restate. (a) The Retorno vencido archive caveat ("Arquiva só os retornos
 *   abertos agora ...") is no longer printed under each customer entry. It
 *   repeated once per customer — twice on this fixture, five times on the
 *   seeded data — so it was guidance at two customers and noise at five, and
 *   the artboard draws it at two. The caveat did not simply go: the owner chose
 *   to fold it into the head mark's ACCESSIBLE NAME, which the delta's
 *   "Every entry can open its conversation and be archived" requirement and its
 *   new "The vencido head mark names the reopen rule" scenario now state. So
 *   the wording is absent visually and present to a screen reader, at the
 *   control, at the moment the reader decides whether to press it. It is one
 *   sentence, not the five-line block, because a name is announced in a single
 *   breath. Nothing else on the screen says archiving is reversible, so the it
 *   that pins this asserts both halves.
 *   (b) An empty section's copy is centred with vertical padding, the
 *   artboard's `.empty`: flush left it read as the first row of a list that
 *   had not finished loading.
 *
 *   Carried forward unchanged from the previous delta: "four counts
 *   and three lists", "Mensagens aguardando resposta leads the card row", "the
 *   fourth section's list SHALL render only while its own card is selected",
 *   "a count card SHALL behave as a toggle", "each entry SHALL lead with the
 *   elapsed time that makes it urgent ... with the absolute date presented as
 *   secondary detail", "MUST NOT render a count of zero for an unknown
 *   section", "the counts SHALL be readable independently of the section lists".
 *
 * The clock is fixed with fake timers, because every elapsed-time caption is
 * measured against `now` and would otherwise change with the calendar.
 *
 * Axes
 *   A1 GET /follow-ups?open outcome — populated / empty / slow / 500
 *   A1b GET /follow-up-counts outcome — populated / 500. Crossed with A1 only
 *      where it changes the screen: counts-ok + lists-500 is the case where the
 *      numbers must survive, and both-500 is the one where nothing is known
 *   A2 card selection — none / the on-demand card / the same card twice
 *   A3 vehicles in a vencido entry — one / several
 *   A4 planned reminders on a vehicle — none / one / several
 *   A5 returnDate vs today — past / today / future. Ordered, so BVA on the
 *      "em atraso" boundary: today−1, today, today+1
 *   A6 conversationId on an entry — present / null. Drives whether the entry
 *      can offer Abrir conversa at all
 *   A7 quoteSentAt parseable — ISO / not a date
 *   A8 GET /follow-ups?closed=1 content, PER SECTION — several archived / one
 *      archived / none. This is the axis the foot strip is a function of
 *   A9 archive subject — a message-pendency entry (the closed-entry table, sent
 *      with its anchor) / one return / every return of a vencido customer
 *   A10 link target — a quote entry with a derived message id / one with null /
 *      a reminder summary whose message was sent / one still entirely un-sent
 *   A11 archived list open on a section — open / closed, crossed with A8
 *   A12 current unit id — resolved from the caller's memberships / never
 *      resolved (null) / stale (names a unit the caller no longer holds).
 *      Crossed with the number of units the caller holds, which is what the
 *      null arm branches on. The RESOLVED arm is driven through
 *      `resolveCurrentUnitId` rather than seeded: an id typed into the Arrange
 *      asserts this screen against a value production might never write, which
 *      is how the chip stayed missing on every real screen while this suite
 *      was green (added 2026-09-07 with bound-session-readiness)
 *
 * Outputs
 *   O1 four count cards, waiting first, three regions
 *   O2 the fourth region present / absent
 *   O3 elapsed-time caption text
 *   O4 per-vehicle sub-rows under one customer
 *   O5 reminder summary text (count + next date)
 *   O6 the unit chip beside the title, as a chip and not as loose text
 *   O7 the count card's caption: uppercase, above the number
 *   O8 the section heading, at level 2, above its card, with its ordering subtitle
 *   O9 accessible name of each × mark, and the absence of fechar / ocultar copy
 *   O10 the close/reopen request body, asserted whole — section, conversation
 *      and the anchor the attendant was looking at
 *   O11 href of the entry link, of Abrir conversa, and of the reminder summary
 *   O12 the foot strip: its count, its names line, its nowrap, its control
 *   O13 DOM order inside a row: text first, then the actions, with nothing
 *      pushing them to the far edge
 *   O14 Portuguese empty / loading / error copy, one alert, and no zero drawn
 *
 * Sampled-cell
 *   the frame                        | A1 populated  | O6 O7 O8 | a loose unit name, a title-case card label, a heading inside the card
 *   unit resolved from memberships   | A12 resolved  | O6       | a chip built from a seeded id no resolver writes
 *   unit id stale                    | A12 stale     | O6       | a confidently wrong unit name
 *   no id, caller holds one unit     | A12 null, 1   | O6       | a fallback nothing exercises, i.e. dead code
 *   no id, caller holds several      | A12 null, 2   | O6       | naming one of them and being wrong half the time
 *   default view                     | A1 A2 none    | O1 O2    | four lists render, or waiting leads a list
 *   selecting the waiting card twice | A2 toggle     | O2       | the filter sticks, or the defaults never come back
 *   vencido groups two cars          | A3 A5 A6      | O3 O4    | a row per car, or a shared caption
 *   due today / tomorrow             | A5 BVA        | O3       | today counted as late
 *   reminders: two, one, none        | A4            | O5       | a bare flag, or a zero count
 *   unparseable quote date           | A7            | O3 O11   | Invalid Date
 *   Abrir conversa where there is one| A6 present    | O11      | the pill missing from an upcoming row the artboard leaves bare
 *   a return with no conversation    | A6 null       | O11      | a pill that lands on the inbox root
 *   actions beside the text          | A1 populated  | O13      | actions pushed to the far right as the artboard draws them
 *   the × marks name their subject   | A9            | O9       | three marks a screen reader cannot tell apart
 *   archiving a quote entry          | A9 entry      | O10      | the row going but the count staying
 *   archiving a whole vencido entry  | A9 customer   | O10      | one car archived out of three
 *   strip on one section, none on another | A8       | O12      | a screen-level closed view, or a strip on an empty archive
 *   the strip in the singular        | A8 one        | O12      | "1 arquivados"
 *   opening and leaving the archive  | A11           | O12      | the other sections losing their queues
 *   unarchiving from the archive     | A8 A11        | O10      | no way back out of the archive
 *   no fechar / ocultar anywhere     | A1 populated  | O9       | the old vocabulary surviving in one control
 *   no snooze anywhere               | A1 populated  | O14      | a date-based hide creeping in
 *   empty lists                      | A1 empty      | O14      | invented rows
 *   slow response                    | A1 slow       | O14      | no loading affordance
 *   500 then success                 | A1+A1b err    | O14      | zeros drawn as counts
 *   lists 500, counts ok             | A1 err A1b ok | O14      | counts lost with the lists
 *
 * Decision / branch map (FollowUpPage)
 *   isLoading              T slow it; F every other it
 *   selected ? … : …       T the selection it; F default-view it
 *   isError || !data       T the two error its; F populated/empty its
 *   counts ?? data.counts  left the counts-ok it; right every other it
 *   counts ? cards : skel  right the slow it, whose counts read fails too
 *   isSelected (card)      T second click of the toggle it; F first click
 *   count ?? "—"           T error it (no counts held); F populated it
 *   rows.length === 0      T empty it; F populated it
 *   plannedReminders       T reminders it; F the bare vehicle in the same it
 *   elapsed > 0 / === 0    both in the BVA it; the negative arm in the same it
 *   Number.isNaN(from)     T unparseable-date it; F every other it
 *   formatDay regex miss   T unparseable-date it; F every other it
 *   archivedOpen[key]      T the archive its; F every other it
 *   archived.count > 0     T the strip it; F the same it's other section
 *   count === 1 (strip)    T the singular it; F the two-archived it
 *   row.conversationId &&  T the Abrir-conversa its; F the null-conversation
 *     !archivedView          upcoming row in the same it
 *   target.kind            entry arm the quote its; return arm the vencido and
 *                          the vehicle its
 *   orderingSubtitle       all three arms in the frame it; the empty-list arms
 *                          in the empty it
 *   archivedSummary        quote arm, vencido arm and upcoming arm in the strip
 *                          its; the `!closed` arm in every it with no archive
 *   chip && sentReminderMessageId && conversationId
 *                          T the sent-reminder it; F the un-sent it (same
 *                          fixture, opposite arm)
 *   messageId ? … : …      T the quote-link it; F the null-quoteMessageId it
 *   units.find(id) hit     T the resolved-id it; F the stale-id it
 *   currentUnitId === null && units.length === 1
 *                          T the sole-unit it; F the several-units it (same
 *                          null id, opposite arm) and the resolved-id it (same
 *                          two units, opposite id arm). Both arms of BOTH
 *                          conjuncts, because either one alone passes against
 *                          an implementation that has lost the other
 *
 * Out of scope: the reminder form itself (ReminderForm.test.tsx); archiving a
 *   return over HTTP (return-reminders.route.test.ts); the page frame's own
 *   ground, padding and heading placement (PageShell.test.tsx); counts calendar
 *   math (API aggregate and return-sections tests).
 *
 * Infeasible (repo-foundation, "Reachable production decisions have both test
 *   outcomes" — named here rather than left one-sided), added 2026-09-07:
 *   - `units[0]?.name ?? null`: the `?? null` arm needs a caller's sole unit to
 *     come back with no name, but `Unit.name` is a required field of the
 *     `GET /units` contract (auth spec, "Units are named, not just
 *     identified") — the API cannot produce the input this arm exists for.
 *   - `open ? (closedQuery.data ?? data) : data`: the `?? data` fallback needs
 *     `open` true while `closedQuery.data` is still undefined, but the only
 *     control that sets `open` true is `Ver os arquivados`, which
 *     `archivedSummary` keeps off the screen until it has already read a
 *     DEFINED `closedQuery.data` (count > 0 requires it) — so by the time a
 *     reader can reach the control, the fallback's premise is already false.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowUpResult } from "@select-lub/shared-types";
import { AppProviders, resolveCurrentUnitId } from "./AppProviders.js";
import { useAuthSession } from "./authSession.js";
import { FollowUpPage } from "./FollowUpPage.js";
import { server } from "../test/msw/server.js";

/** Every elapsed-time caption below is counted from this instant. */
const NOW = new Date("2026-09-02T15:00:00.000Z");

/**
 * Matches the Retorno vencido head mark by its opening clause.
 *
 * A fragment rather than the whole accessible name on purpose. The name now
 * carries a second clause — the reopen caveat — which is copy the owner may
 * still tune, and these three call sites are about REACHING the control, not
 * about its wording. The one it that asserts the wording asserts it directly,
 * so a copy change fails that test alone instead of every test that clicks the
 * mark. Anchored at the start so it cannot match one of the other two marks.
 */
const VENCIDO_HEAD_MARK = /^Arquivar os retornos abertos deste cliente/;

const emptyResult: FollowUpResult = {
  counts: {
    unansweredQuotes: 0,
    overdueReturns: 0,
    upcomingReturns: 0,
    waitingReply: 0,
  },
  unansweredQuotes: [],
  overdueReturns: [],
  upcomingReturns: [],
  waitingReply: [],
};

const populated: FollowUpResult = {
  counts: {
    unansweredQuotes: 1,
    overdueReturns: 1,
    upcomingReturns: 2,
    waitingReply: 1,
  },
  unansweredQuotes: [
    {
      conversationId: "c-quote",
      quoteId: "q1",
      quoteSentAt: "2026-08-28T12:00:00.000Z",
      label: "Roberto Aparecido",
      quoteMessageId: "m-quote",
    },
  ],
  overdueReturns: [
    {
      customerId: "cust-1",
      conversationId: "c-overdue",
      label: "Carlos Mendes",
      vehicles: [
        {
          vehicleId: "veh-1",
          plate: "ABC-1D23",
          model: "Toyota Corolla",
          returnId: "ret-1",
          returnDate: "2026-07-15",
          sourceServiceId: "s1",
          plannedReminders: { count: 2, nextAt: "2026-09-04T12:00:00.000Z" },
        },
        {
          vehicleId: "veh-3",
          plate: "QRS-2B10",
          model: "Ford Ka",
          returnId: "ret-3",
          returnDate: "2026-09-01",
          sourceServiceId: "s3",
        },
      ],
    },
  ],
  upcomingReturns: [
    {
      customerId: "cust-2",
      conversationId: null,
      label: "Paulo Lima",
      vehicle: {
        vehicleId: "veh-2",
        plate: "LMN-7C45",
        model: "Fiat Argo",
        returnId: "ret-2",
        returnDate: "2026-09-02",
        sourceServiceId: "s2",
        plannedReminders: { count: 1, nextAt: "2026-09-01T12:00:00.000Z" },
      },
    },
    {
      customerId: "cust-3",
      conversationId: "c-soon",
      label: "Ana Souza",
      vehicle: {
        vehicleId: "veh-4",
        plate: null,
        model: null,
        returnId: "ret-4",
        returnDate: "2026-09-03",
        sourceServiceId: "s4",
      },
    },
  ],
  waitingReply: [
    {
      conversationId: "c-wait",
      oldestPendingAt: "2026-08-27T10:00:00.000Z",
      label: "Juliana Alves",
    },
  ],
};

/** Two quote entries archived out of Orçamentos, and nothing archived elsewhere. */
const archivedQuotes: FollowUpResult = {
  ...emptyResult,
  unansweredQuotes: [
    {
      conversationId: "c-b",
      quoteId: "q-b",
      quoteSentAt: "2026-08-20T12:00:00.000Z",
      label: "Beatriz Nunes",
      quoteMessageId: null,
      closed: { anchor: "q-b", at: "2026-09-01T09:00:00.000Z", byUserId: "user-1" },
    },
    {
      conversationId: "c-t",
      quoteId: "q-t",
      quoteSentAt: "2026-08-21T12:00:00.000Z",
      label: "Tiago Ferraz",
      quoteMessageId: null,
      closed: { anchor: "q-t", at: "2026-09-01T09:00:00.000Z", byUserId: "user-1" },
    },
  ],
};

/**
 * One handler answering both reads the screen makes of `/follow-ups`.
 *
 * @param open - Payload for the queue read.
 * @param closed - Payload for `?closed=1`; nothing archived by default, which
 *   is the case that must draw no strip at all.
 * @returns The MSW handler.
 */
function followUps(open: FollowUpResult, closed: FollowUpResult = emptyResult) {
  return http.get("*/api/follow-ups", ({ request }) =>
    HttpResponse.json(new URL(request.url).searchParams.get("closed") === "1" ? closed : open),
  );
}

/**
 * Clicks through user-event with the fake clock wired in.
 *
 * @param element - The control to click.
 * @returns Resolves once React has flushed the interaction.
 */
function click(element: HTMLElement) {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(element);
}

/** Resolves once the first response has replaced the loading skeletons. */
function settled() {
  return screen.findByRole("button", { name: /Mensagens aguardando resposta/ });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <FollowUpPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps timers ticking on their own, which MSW and
  // TanStack Query both need to settle; only the starting instant is pinned.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
  useAuthSession.setState({ currentUnitId: null });
});

describe("the unit the screen is scoped to", () => {
  it("names the unit as a chip beside the title", async () => {
    // The id is RESOLVED through the same function the app resolves it with,
    // not typed in here as a literal. Seeding it would assert this screen
    // against a value production might never write — which is exactly how the
    // chip stayed missing on every real screen while this suite was green.
    // Two memberships and no resolvable current unit, so the resolver falls
    // back to the first, and the chip names the unit that fallback picked.
    server.use(
      followUps(populated),
      http.get("*/api/auth/me", () =>
        HttpResponse.json({
          id: "11111111-1111-1111-1111-111111111111",
          email: "attendant@example.com",
          name: "Atendente",
          unitIds: ["u1", "u2"],
        }),
      ),
      http.get("*/api/units", () =>
        HttpResponse.json([
          { id: "u1", name: "Unidade Centro" },
          { id: "u2", name: "Unidade Norte" },
        ]),
      ),
    );
    useAuthSession.setState({ currentUnitId: await resolveCurrentUnitId(2000) });
    renderPage();
    await settled();

    const name = await screen.findByText("Unidade Centro");
    // A chip, not loose text beside the title: the artboard draws the unit as
    // a pill, and a bare word next to an h1 reads as part of the title.
    expect(name.closest(".MuiChip-root")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Follow-up" })).toBeInTheDocument();
    // The other unit the caller holds is not the one in scope.
    expect(screen.queryByText("Unidade Norte")).toBeNull();
  });

  it("names nothing rather than something wrong when the stored id is stale", async () => {
    // The id is resolved once at sign-in and held for the session, so it
    // outlives access being withdrawn mid-session. Seeded deliberately: the
    // point of this it is an id the CALLER no longer holds, which resolution
    // cannot produce at the moment it runs. No name beats a confidently wrong
    // one, and the contract makes `name` required so there is no identifier to
    // fall back to.
    useAuthSession.setState({ currentUnitId: "gone" });
    server.use(
      followUps(populated),
      http.get("*/api/units", () => HttpResponse.json([{ id: "u1", name: "Unidade Centro" }])),
    );
    renderPage();
    await settled();

    expect(screen.queryByText("Unidade Centro")).toBeNull();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("names the sole unit the caller holds when no current unit id was ever set", async () => {
    // The fallback's remaining reason to exist. Sign-in now resolves
    // `currentUnitId` from the caller's memberships, so a null id no longer
    // means "always"; it means the `GET /auth/me` read failed or hit its
    // deadline, or the caller holds no memberships. This it seeds NOTHING, so
    // it is the one that proves the fallback still fires — and the resolved-id
    // it above is the one that proves resolution works. Neither alone is
    // enough: with every it seeding, nothing exercises the fallback; with only
    // this one, nothing catches resolution being broken, because a broken
    // resolver and an unresolved unit produce the same null.
    //
    // Naming the sole unit is not a guess: with one membership that unit is
    // what every request is scoped to whatever `x-unit-id` says, because the
    // API resolves an absent header against the caller's own memberships.
    server.use(
      followUps(populated),
      http.get("*/api/units", () => HttpResponse.json([{ id: "u1", name: "Unidade Centro" }])),
    );
    renderPage();
    await settled();

    const name = await screen.findByText("Unidade Centro");
    expect(name.closest(".MuiChip-root")).not.toBeNull();
  });

  it("names nothing when no id was set and the caller holds several units", async () => {
    // The other half of the fallback, and the reason it is not simply "the
    // first unit": with several memberships and no id the page genuinely
    // cannot tell which queue it is showing, so it says nothing rather than
    // naming one of them and being wrong half the time.
    server.use(
      followUps(populated),
      http.get("*/api/units", () =>
        HttpResponse.json([
          { id: "u1", name: "Unidade Centro" },
          { id: "u2", name: "Unidade Norte" },
        ]),
      ),
    );
    renderPage();
    await settled();

    expect(screen.queryByText("Unidade Centro")).toBeNull();
    expect(screen.queryByText("Unidade Norte")).toBeNull();
  });

  it("still renders the queue when the units read fails", async () => {
    useAuthSession.setState({ currentUnitId: "u1" });
    server.use(
      followUps(populated),
      http.get("*/api/units", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
    );
    renderPage();

    // Naming the unit is a courtesy; the queue is the screen's job.
    expect(await settled()).toBeInTheDocument();
  });
});

describe("the artboard's frame", () => {
  it("prints each count card's section name as an uppercase caption above the number", async () => {
    server.use(followUps(populated));

    renderPage();
    await settled();

    const card = screen.getByRole("button", { name: /Orçamentos sem resposta/ });
    const label = within(card).getByText("Orçamentos sem resposta");
    // Uppercased by the stylesheet, not by the copy: the accessible name and
    // the fixture stay in sentence case.
    expect(label).toHaveStyle({ textTransform: "uppercase" });
    // Label above number, in that order.
    expect(card.textContent).toBe("Orçamentos sem resposta1");
  });

  it("puts each section heading above its card with its ordering subtitle", async () => {
    server.use(followUps(populated));

    renderPage();
    await settled();

    expect(
      screen.getByRole("heading", { level: 2, name: "Orçamentos sem resposta" }),
    ).toBeInTheDocument();
    expect(screen.getByText("mais antigo primeiro")).toBeInTheDocument();
    // The return sections count what they are about before naming the order.
    expect(screen.getByText("1 cliente · 2 veículos · mais atrasado primeiro")).toBeInTheDocument();
    expect(screen.getByText("2 veículos · mais iminente primeiro")).toBeInTheDocument();
    // The heading is outside the card, so the card holds only entries.
    const heading = screen.getByRole("heading", { level: 2, name: "Retorno vencido" });
    expect(within(heading).queryByText("Carlos Mendes")).toBeNull();
  });
});

describe("row actions", () => {
  it("offers Abrir conversa on every entry that has a conversation to open", async () => {
    server.use(followUps(populated));

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    // Same target as the entry's own link, quote-message position included.
    expect(within(quotes).getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/?conversation=c-quote&message=m-quote",
    );
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/?conversation=c-overdue",
    );
    // An upcoming row with a thread gets the pill too — spec over artboard,
    // which draws none on that section.
    const upcoming = screen.getByRole("region", { name: "Retorno se aproximando" });
    const opens = within(upcoming).getAllByRole("link", { name: "Abrir conversa" });
    expect(opens).toHaveLength(1);
    expect(opens[0]).toHaveAttribute("href", "/?conversation=c-soon");
  });

  it("gives a return without a conversation no Abrir conversa at all", async () => {
    // Paulo Lima's return carries a null `conversationId`, and
    // `conversationHref(null)` is the inbox root: a pill named "Abrir
    // conversa" that lands there has told the reader something untrue.
    server.use(followUps(populated));

    renderPage();
    await settled();

    const upcoming = screen.getByRole("region", { name: "Retorno se aproximando" });
    // Two entries in the section — both still schedule a reminder — but only
    // the one that has a thread offers to open it.
    expect(within(upcoming).getAllByRole("button", { name: "Criar lembrete" })).toHaveLength(2);
    expect(within(upcoming).getAllByRole("link", { name: "Abrir conversa" })).toHaveLength(1);
    // No Abrir conversa anywhere points at the inbox root, which is where
    // `conversationHref(null)` would have sent it. The entry's own name is no
    // longer a link at all when there is no conversation, so the "/" the old
    // title link degraded to is gone with the head row that carried it.
    for (const open of screen.getAllByRole("link", { name: "Abrir conversa" })) {
      expect(open).not.toHaveAttribute("href", "/");
    }
  });

  // Same nullable conversationId as PairLead: a name with no thread is
  // Typography, not a Link to conversationHref(null) ("/").
  it("gives a Retorno vencido customer with no conversation no link on their name either", async () => {
    // followUpOverdueEntrySchema.conversationId is nullable. PairLead already
    // keeps a link off Retorno se aproximando's name; the vencido customer
    // head now uses the same conversationId guard.
    server.use(
      followUps({
        ...emptyResult,
        counts: { ...emptyResult.counts, overdueReturns: 1 },
        overdueReturns: [
          {
            customerId: "cust-none",
            conversationId: null,
            label: "Fernanda Reis",
            vehicles: [
              {
                vehicleId: "veh-none",
                plate: "NNN-0N00",
                model: "Renault Kwid",
                returnId: "ret-none",
                returnDate: "2026-06-01",
                sourceServiceId: "s-none",
              },
            ],
          },
        ],
      }),
    );

    renderPage();
    await settled();

    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).queryByRole("link", { name: "Fernanda Reis" })).toBeNull();
    expect(within(overdue).getByText("Fernanda Reis")).toBeInTheDocument();
  });

  it("keeps a row's actions on its own line right after its text", async () => {
    // The owner's decision of 2026-09-05, a deliberate departure from the
    // artboard: a control never travels to the far edge, away from the text it
    // acts on.
    server.use(followUps(populated));

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    const open = within(quotes).getByRole("link", { name: "Abrir conversa" });
    const row = open.parentElement as HTMLElement;
    expect(row).toContainElement(within(quotes).getByRole("link", { name: /5 dias sem resposta/ }));
    // Text block first, actions after it, and nothing pushing them right.
    expect(row.firstElementChild).toContainElement(
      within(quotes).getByRole("link", { name: /5 dias sem resposta/ }),
    );
    expect(open).not.toHaveStyle({ marginLeft: "auto" });
  });

  it("carries the vencido caveat on the mark's name, not as a paragraph per customer", async () => {
    // The caveat used to print under every Retorno vencido customer — twice on
    // this fixture, five times on the seeded data. It was guidance at two
    // customers and noise at five, and the artboard draws it at two, so the
    // owner took it off the screen at the 2026-09-05 sign-off and chose to have
    // it return as the head mark's accessible name instead.
    //
    // This it guards BOTH halves of that decision, which is why it asserts the
    // wording rather than reaching the control through VENCIDO_HEAD_MARK: gone
    // visually, and present to a screen reader at the control itself. Deleting
    // the paragraph without the name would silently drop the only statement
    // that archiving is reversible — nothing else on the screen says so.
    server.use(followUps(populated));

    renderPage();
    await settled();

    // Not on the screen, in any wording: neither the old sentence nor the new
    // one is printed as text.
    const page = screen.getByRole("main").textContent ?? "";
    expect(page).not.toMatch(/Arquiva só os retornos/);
    expect(page).not.toMatch(/abre um retorno novo/);

    // Present as the mark's name, and it says both things: what is archived,
    // and that a newer service reopens the return here.
    const mark = screen.getByRole("button", { name: VENCIDO_HEAD_MARK });
    const name = mark.getAttribute("aria-label") ?? "";
    expect(name).toMatch(/retornos abertos deste cliente/);
    expect(name).toMatch(/serviço novo em qualquer carro do cliente abre um retorno novo aqui/);
    // One sentence, not the block it replaced: a name is read in one breath.
    expect(name.split(". ").length).toBe(1);
  });

  it("names what each × mark archives, and never says fechar or ocultar", async () => {
    server.use(followUps(populated));

    renderPage();
    await settled();

    expect(screen.getByRole("button", { name: "Arquivar esta pendência" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: VENCIDO_HEAD_MARK }),
    ).toBeInTheDocument();
    // One per listed vehicle: two overdue cars plus two upcoming ones.
    expect(screen.getAllByRole("button", { name: "Arquivar este retorno" })).toHaveLength(4);
    // The old vocabulary is gone from the copy and from every accessible name.
    const page = screen.getByRole("main");
    expect(page.textContent ?? "").not.toMatch(/fechar|ocultar/i);
    for (const control of screen.getAllByRole("button")) {
      expect(control.getAttribute("aria-label") ?? "").not.toMatch(/fechar|ocultar/i);
    }
    expect(screen.queryByRole("button", { name: "Ver entradas fechadas" })).toBeNull();
  });

  it("archives a quote entry through its mark, dropping it from its list and its count", async () => {
    let archived = false;
    const closeCalls: unknown[] = [];
    server.use(
      http.get("*/api/follow-ups", ({ request }) => {
        const wantClosed = new URL(request.url).searchParams.get("closed") === "1";
        const listed = wantClosed === archived;
        return HttpResponse.json({
          ...emptyResult,
          counts: { ...emptyResult.counts, unansweredQuotes: archived ? 0 : 1 },
          unansweredQuotes: listed
            ? [
                {
                  conversationId: "c-quote",
                  quoteId: "q1",
                  quoteSentAt: "2026-08-28T12:00:00.000Z",
                  label: "Roberto Aparecido",
                  quoteMessageId: "m-quote",
                  ...(archived
                    ? {
                        closed: {
                          anchor: "q1",
                          at: "2026-09-01T09:00:00.000Z",
                          byUserId: "user-1",
                        },
                      }
                    : {}),
                },
              ]
            : [],
        } satisfies FollowUpResult);
      }),
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ ...emptyResult.counts, unansweredQuotes: archived ? 0 : 1 }),
      ),
      http.post("*/api/follow-ups/close", async ({ request }) => {
        closeCalls.push(await request.json());
        archived = true;
        return HttpResponse.json({});
      }),
    );

    renderPage();
    await settled();
    expect(screen.getByText(/Roberto Aparecido/)).toBeInTheDocument();

    await click(screen.getByRole("button", { name: "Arquivar esta pendência" }));

    await screen.findByText("Nenhum orçamento sem resposta.");
    // The anchor travels with the request: it is what the attendant was looking
    // at, so a newer quote cannot be suppressed by this click.
    expect(closeCalls).toEqual([
      { section: "unansweredQuotes", conversationId: "c-quote", anchor: "q1" },
    ]);
    // Count and list move together — a card still reading 1 would send someone
    // looking for a row that is no longer there.
    expect(screen.getByRole("button", { name: /Orçamentos sem resposta/ })).toHaveTextContent(
      "Orçamentos sem resposta0",
    );
  });

  it("archives every open return of a vencido customer from the entry's own mark", async () => {
    // The entry IS the customer, so its mark archives the cars listed right
    // now — not one of them, and not a car a later service opens.
    const archived: string[] = [];
    server.use(
      followUps(populated),
      http.post("*/api/vehicle-returns/:returnId/archive", ({ params }) => {
        archived.push(String(params.returnId));
        return HttpResponse.json({});
      }),
    );

    renderPage();
    await settled();

    await click(screen.getByRole("button", { name: VENCIDO_HEAD_MARK }));

    expect(archived.sort()).toEqual(["ret-1", "ret-3"]);
  });

  it("shows a Portuguese error and leaves the row in place when archiving a return fails", async () => {
    // closeMutation.isError: no prior it drove a close/reopen write to a
    // failure, so this Alert had never rendered.
    server.use(
      followUps(populated),
      http.post("*/api/vehicle-returns/:returnId/archive", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderPage();
    await settled();

    await click(screen.getAllByRole("button", { name: "Arquivar este retorno" })[0] as HTMLElement);

    expect(await screen.findByText("Não foi possível atualizar esta entrada")).toBeInTheDocument();
    // The failed write did not invalidate the queue, so the row it targeted
    // (Carlos Mendes' Corolla) is still exactly where it was.
    expect(screen.getByText("Toyota Corolla · ABC-1D23")).toBeInTheDocument();
  });
});

describe("the per-section archived strip", () => {
  it("ends a section holding archived entries with a one-line strip, and draws none on a section without", async () => {
    server.use(followUps(populated, archivedQuotes));

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    const count = within(quotes).getByText("2 arquivados");
    // One line: the PDF's export width broke this across two, and the strip's
    // whole job is to be legible at a glance.
    expect(count).toHaveStyle({ whiteSpace: "nowrap" });
    expect(within(quotes).getByText("Beatriz Nunes, Tiago Ferraz")).toBeInTheDocument();
    expect(within(quotes).getByRole("button", { name: "Ver os arquivados" })).toBeInTheDocument();
    // Retorno vencido has nothing archived, so it says nothing at all.
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).queryByText(/arquivad/)).toBeNull();
    expect(within(overdue).queryByRole("button", { name: /Ver os? arquivado/ })).toBeNull();
  });

  it("says arquivado in the singular for a section holding one", async () => {
    server.use(
      followUps(populated, {
        ...emptyResult,
        unansweredQuotes: [archivedQuotes.unansweredQuotes[0]],
      }),
    );

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    expect(within(quotes).getByText("1 arquivado")).toBeInTheDocument();
    expect(within(quotes).getByRole("button", { name: "Ver o arquivado" })).toBeInTheDocument();
  });

  it("opens the archived list inside the same card and returns to the queue", async () => {
    server.use(followUps(populated, archivedQuotes));

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    await click(within(quotes).getByRole("button", { name: "Ver os arquivados" }));

    // The archived entries are listed in this section's own card.
    expect(within(quotes).getByText(/Beatriz Nunes/)).toBeInTheDocument();
    expect(within(quotes).getAllByRole("button", { name: "Desarquivar" })).toHaveLength(2);
    // The queue it replaced is gone from this card, and so is the strip.
    expect(within(quotes).queryByText(/Roberto Aparecido/)).toBeNull();
    expect(within(quotes).queryByRole("button", { name: "Ver os arquivados" })).toBeNull();
    // Every other section keeps showing its queue: the strip belongs to the
    // section whose queue it explains, not to the screen.
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).getByText("Carlos Mendes")).toBeInTheDocument();

    await click(within(quotes).getByRole("button", { name: "Voltar para a fila" }));
    expect(within(quotes).getByText(/Roberto Aparecido/)).toBeInTheDocument();
    expect(within(quotes).getByRole("button", { name: "Ver os arquivados" })).toBeInTheDocument();
  });

  it("unarchives an entry from the archived list", async () => {
    const reopenCalls: unknown[] = [];
    server.use(
      followUps(populated, archivedQuotes),
      http.post("*/api/follow-ups/reopen", async ({ request }) => {
        reopenCalls.push(await request.json());
        return HttpResponse.json({});
      }),
    );

    renderPage();
    await settled();

    const quotes = screen.getByRole("region", { name: "Orçamentos sem resposta" });
    await click(within(quotes).getByRole("button", { name: "Ver os arquivados" }));
    await click(within(quotes).getAllByRole("button", { name: "Desarquivar" })[0] as HTMLElement);

    expect(reopenCalls).toEqual([
      { section: "unansweredQuotes", conversationId: "c-b", anchor: "q-b" },
    ]);
  });

  it("draws no strip while the closed read is still pending", async () => {
    // archivedSummary's `!closed` guard: the closed read fails or lags
    // independently of the queue, and a section then says nothing rather than
    // claiming an archive it cannot yet confirm is empty.
    server.use(
      http.get("*/api/follow-ups", async ({ request }) => {
        if (new URL(request.url).searchParams.get("closed") === "1") {
          await delay("infinite");
        }
        return HttpResponse.json(populated);
      }),
    );

    renderPage();
    await settled();

    expect(screen.getByText(/Roberto Aparecido/)).toBeInTheDocument();
    expect(screen.queryByText(/arquivad/)).toBeNull();
  });

  it("opens the Retorno vencido archived view and unarchives a vehicle from it", async () => {
    // The overdue and upcoming sections share the same archived-view path as
    // the quote sections above, but no prior it had opened one of THEIR
    // strips or driven their VehicleRow-level Desarquivar to the return
    // unarchive endpoint.
    const archivedOverdue: FollowUpResult = {
      ...emptyResult,
      overdueReturns: [
        {
          customerId: "cust-9",
          conversationId: "c-fernanda",
          label: "Fernanda Reis",
          vehicles: [
            {
              vehicleId: "veh-9",
              plate: "XYZ-9A87",
              model: "VW Gol",
              returnId: "ret-9",
              returnDate: "2026-06-01",
              sourceServiceId: "s9",
            },
          ],
        },
      ],
    };
    const reopened: string[] = [];
    server.use(
      followUps(populated, archivedOverdue),
      http.post("*/api/vehicle-returns/:returnId/unarchive", ({ params }) => {
        reopened.push(String(params.returnId));
        return HttpResponse.json({});
      }),
    );

    renderPage();
    await settled();

    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    // One vehicle archived, so the strip and its control are singular.
    await click(within(overdue).getByRole("button", { name: "Ver o arquivado" }));

    // The open queue (Carlos Mendes) steps aside for the archived entry, whose
    // only actions are Desarquivar: no Abrir conversa and no head archive mark
    // while looking at something already archived.
    expect(within(overdue).getByText("Fernanda Reis")).toBeInTheDocument();
    expect(within(overdue).queryByText("Carlos Mendes")).toBeNull();
    expect(within(overdue).queryByRole("link", { name: "Abrir conversa" })).toBeNull();
    expect(within(overdue).queryByRole("button", { name: VENCIDO_HEAD_MARK })).toBeNull();

    await click(within(overdue).getByRole("button", { name: "Desarquivar" }));
    expect(reopened).toEqual(["ret-9"]);

    await click(within(overdue).getByRole("button", { name: "Voltar para a fila" }));
    expect(within(overdue).getByText("Carlos Mendes")).toBeInTheDocument();
  });

  it("says the car already has an open return, so this one cannot come back, and re-reads the lists", async () => {
    // The api refuses the unarchive with 409 return_not_archived: the reconcile
    // superseded the archived return, or its vehicle already has an open one
    // (owner rulings, 2026-09-25). Before, this read as a generic failure.
    const archivedOverdue: FollowUpResult = {
      ...emptyResult,
      overdueReturns: [
        {
          customerId: "cust-9",
          conversationId: "c-fernanda",
          label: "Fernanda Reis",
          vehicles: [
            {
              vehicleId: "veh-9",
              plate: "XYZ-9A87",
              model: "VW Gol",
              returnId: "ret-9",
              returnDate: "2026-06-01",
              sourceServiceId: "s9",
            },
          ],
        },
      ],
    };
    let listReads = 0;
    server.use(
      http.get("*/api/follow-ups", ({ request }) => {
        listReads += 1;
        return HttpResponse.json(new URL(request.url).searchParams.get("closed") === "1" ? archivedOverdue : populated);
      }),
      http.post("*/api/vehicle-returns/:returnId/unarchive", () =>
        HttpResponse.json({ error: "return_not_archived" }, { status: 409 }),
      ),
    );

    renderPage();
    await settled();
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    await click(within(overdue).getByRole("button", { name: "Ver o arquivado" }));
    const readsBefore = listReads;

    await click(within(overdue).getByRole("button", { name: "Desarquivar" }));

    expect(
      await screen.findByText("Este carro já tem um retorno aberto, e este não pode voltar para a fila."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível atualizar esta entrada")).toBeNull();
    // onError awaits the re-read before the mutation reports its error, so by
    // the time the message shows, the lists have been fetched again.
    expect(listReads).toBeGreaterThan(readsBefore);
  });

  it("still reads a failed unarchive for any other reason as a generic failure", async () => {
    const archivedOverdue: FollowUpResult = {
      ...emptyResult,
      overdueReturns: [
        {
          customerId: "cust-9",
          conversationId: "c-fernanda",
          label: "Fernanda Reis",
          vehicles: [
            {
              vehicleId: "veh-9",
              plate: "XYZ-9A87",
              model: "VW Gol",
              returnId: "ret-9",
              returnDate: "2026-06-01",
              sourceServiceId: "s9",
            },
          ],
        },
      ],
    };
    server.use(
      followUps(populated, archivedOverdue),
      http.post("*/api/vehicle-returns/:returnId/unarchive", () => HttpResponse.json({}, { status: 500 })),
    );

    renderPage();
    await settled();
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    await click(within(overdue).getByRole("button", { name: "Ver o arquivado" }));
    await click(within(overdue).getByRole("button", { name: "Desarquivar" }));

    expect(await screen.findByText("Não foi possível atualizar esta entrada")).toBeInTheDocument();
    expect(screen.queryByText(/já tem um retorno aberto/)).toBeNull();
  });
});

describe("FollowUpPage", () => {
  it("shows four counts and only the three default lists", async () => {
    server.use(followUps(populated));

    renderPage();

    await settled();
    const cards = screen.getAllByRole("button", { pressed: false });
    // Mensagens aguardando resposta leads the row even though its list does not render.
    expect(cards.map((card) => card.textContent)).toEqual([
      "Mensagens aguardando resposta1",
      "Orçamentos sem resposta1",
      "Retorno vencido1",
      "Retorno se aproximando2",
    ]);
    expect(screen.getByRole("region", { name: "Retorno vencido" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Retorno se aproximando" })).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Mensagens aguardando resposta" }),
    ).not.toBeInTheDocument();
  });

  it("opens the fourth list on its card and closes it on the same card", async () => {
    server.use(followUps(populated));

    renderPage();

    const card = await screen.findByRole("button", { name: /Mensagens aguardando resposta/ });
    await click(card);

    const waiting = screen.getByRole("region", { name: "Mensagens aguardando resposta" });
    expect(
      within(waiting).getByRole("link", { name: "Juliana Alves · 6 dias aguardando" }),
    ).toHaveAttribute("href", "/?conversation=c-wait");
    // Filtered to one section: the defaults step aside while a card is selected.
    expect(screen.queryByRole("region", { name: "Retorno vencido" })).not.toBeInTheDocument();

    await click(screen.getByRole("button", { name: /Mensagens aguardando resposta/ }));
    expect(screen.getByRole("region", { name: "Retorno vencido" })).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Mensagens aguardando resposta" }),
    ).not.toBeInTheDocument();
  });

  it("groups one customer's overdue cars under a single entry, each with its own age", async () => {
    server.use(followUps(populated));

    renderPage();

    await settled();
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    // One customer link, not one per car; Abrir conversa is the second link and
    // goes to the same thread.
    expect(within(overdue).getByRole("link", { name: "Carlos Mendes" })).toHaveAttribute(
      "href",
      "/?conversation=c-overdue",
    );
    expect(within(overdue).getByText("Toyota Corolla · ABC-1D23")).toBeInTheDocument();
    expect(within(overdue).getByText("49 dias em atraso")).toBeInTheDocument();
    expect(within(overdue).getByText("Ford Ka · QRS-2B10")).toBeInTheDocument();
    expect(within(overdue).getByText("1 dia em atraso")).toBeInTheDocument();
    // The absolute date is still there, as secondary detail.
    expect(within(overdue).getByText("previsto 15/07/2026")).toBeInTheDocument();
  });

  it("separates due today from a day late and from a day out", async () => {
    server.use(followUps(populated));

    renderPage();

    await settled();
    const upcoming = screen.getByRole("region", { name: "Retorno se aproximando" });
    // 02/09 is today: the day has not passed, so it is not late.
    expect(within(upcoming).getByText("vence hoje")).toBeInTheDocument();
    expect(within(upcoming).getByText("vence em 1 dia")).toBeInTheDocument();
    // 01/09 in the vencido section is the other side of the same boundary.
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).getByText("1 dia em atraso")).toBeInTheDocument();
  });

  it("names a Retorno se aproximando pair once — customer, then the car beneath", async () => {
    // The section lists one customer-vehicle PAIR per row, so the artboard
    // draws the customer bold with the car as a caption under them
    // (`.pair-row` / `.pair-veh`). The head row this replaced printed
    // "Paulo Lima · Fiat Argo · LMN-7C45" and then handed the same car to the
    // vehicle line below it, so every row said the vehicle twice.
    server.use(followUps(populated));

    renderPage();
    await settled();

    const upcoming = screen.getByRole("region", { name: "Retorno se aproximando" });
    // Exactly one node carries the car, and the customer is not glued to it.
    expect(within(upcoming).getAllByText("Fiat Argo · LMN-7C45")).toHaveLength(1);
    expect(within(upcoming).queryByText(/Paulo Lima ·/)).toBeNull();
    expect(within(upcoming).getByText("Paulo Lima")).toBeInTheDocument();
    // The row still carries everything the artboard puts on it, in order:
    // the pair, the elapsed time, the date, the reminder chip, the actions.
    const row = within(upcoming).getByText("Paulo Lima").closest(".MuiStack-root")?.parentElement;
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("vence hoje")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("previsto 02/09/2026")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByRole("button", { name: "Criar lembrete" }),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByRole("button", { name: "Arquivar este retorno" }),
    ).toBeInTheDocument();
  });

  it("says how many reminders a vehicle holds and when the next one lands", async () => {
    server.use(followUps(populated));

    renderPage();

    await settled();
    const overdue = screen.getByRole("region", { name: "Retorno vencido" });
    expect(within(overdue).getByText("2 lembretes · próximo 04/09/2026")).toBeInTheDocument();
    const upcoming = screen.getByRole("region", { name: "Retorno se aproximando" });
    expect(within(upcoming).getByText("1 lembrete · próximo 01/09/2026")).toBeInTheDocument();
    // The car with none carries no summary at all — not a count of zero.
    expect(within(upcoming).queryByText(/0 lembrete/)).not.toBeInTheDocument();
    expect(within(upcoming).getByText("Veículo sem identificação")).toBeInTheDocument();
  });

  it("leads a quote entry with how long it has gone unanswered", async () => {
    server.use(followUps(populated));

    renderPage();

    const quote = await screen.findByRole("link", {
      name: "Roberto Aparecido · 5 dias sem resposta",
    });
    // The entry opens the thread positioned on the quote itself.
    expect(quote).toHaveAttribute("href", "/?conversation=c-quote&message=m-quote");
    expect(screen.getByText("orçamento enviado 28/08/2026")).toBeInTheDocument();
  });

  it("keeps an unparseable quote date as received instead of Invalid Date", async () => {
    server.use(
      followUps({
        ...emptyResult,
        counts: { ...emptyResult.counts, unansweredQuotes: 1 },
        unansweredQuotes: [
          {
            conversationId: "c-quote",
            quoteId: "q-odd",
            quoteSentAt: "ontem",
            label: "Roberto Aparecido",
            // The server could not derive a message for this one; the link has
            // to degrade rather than break.
            quoteMessageId: null,
          },
        ],
      }),
    );

    renderPage();

    expect(
      await screen.findByRole("link", { name: "Roberto Aparecido · 0 dias sem resposta" }),
    ).toBeInTheDocument();
    expect(screen.getByText("orçamento enviado ontem")).toBeInTheDocument();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
    // With no message to position on, Abrir conversa degrades to the thread.
    expect(screen.getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/?conversation=c-quote",
    );
  });

  it("shows Portuguese empty copy in each rendered section", async () => {
    server.use(followUps(emptyResult));

    renderPage();

    expect(await screen.findByText("Nenhum orçamento sem resposta.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum retorno vencido.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum retorno se aproximando.")).toBeInTheDocument();
    // Nothing to count, so the headings fall back to the bare ordering.
    expect(screen.getByText("mais atrasado primeiro")).toBeInTheDocument();
    expect(screen.getByText("mais iminente primeiro")).toBeInTheDocument();

    await click(screen.getByRole("button", { name: /Mensagens aguardando resposta/ }));
    expect(screen.getByText("Nenhuma mensagem aguardando resposta.")).toBeInTheDocument();
  });

  it("centres an empty section's copy with vertical padding, as the artboard's .empty", async () => {
    // Flush left at the card's edge, the line read as the first row of a list
    // that had not finished loading. Centring is what makes an empty card look
    // deliberately empty rather than unfinished.
    server.use(followUps(emptyResult));

    renderPage();

    const empty = await screen.findByText("Nenhum orçamento sem resposta.");
    expect(empty).toHaveStyle({ textAlign: "center" });
    // Padding above and below, not a bare line against the card's top edge.
    const { paddingTop, paddingBottom } = getComputedStyle(empty);
    expect(paddingTop).not.toBe("0px");
    expect(paddingBottom).not.toBe("0px");
  });

  it("shows a Portuguese loading state", async () => {
    server.use(
      http.get("*/api/follow-ups", async () => {
        await delay("infinite");
        return HttpResponse.json(emptyResult);
      }),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getAllByText("Carregando follow-up")).toHaveLength(3);
  });

  it("opens the reminder summary on the message it already sent", async () => {
    server.use(
      followUps({
        ...emptyResult,
        counts: { ...emptyResult.counts, overdueReturns: 1 },
        overdueReturns: [
          {
            customerId: "cust-1",
            conversationId: "c-overdue",
            label: "Carlos Mendes",
            vehicles: [
              {
                vehicleId: "veh-1",
                plate: "ABC-1D23",
                model: "Toyota Corolla",
                returnId: "ret-1",
                returnDate: "2026-07-15",
                sourceServiceId: "s1",
                plannedReminders: { count: 2, nextAt: "2026-09-04T12:00:00.000Z" },
                sentReminderMessageId: "m-reminder",
              },
            ],
          },
        ],
      }),
    );

    renderPage();
    await settled();

    expect(screen.getByRole("link", { name: /2 lembretes/ })).toHaveAttribute(
      "href",
      "/?conversation=c-overdue&message=m-reminder",
    );
  });

  it("leaves the summary inert while every reminder is still un-sent", async () => {
    // Nothing has gone out, so there is no bubble in the thread to open on.
    // A link to the conversation's normal position would claim otherwise.
    server.use(followUps(populated));

    renderPage();
    await settled();

    expect(screen.queryByRole("link", { name: /2 lembretes/ })).toBeNull();
    expect(screen.getByText(/2 lembretes · próximo 04\/09\/2026/)).toBeInTheDocument();
  });

  it("offers no way to hide an entry until a date", async () => {
    // Deliberate: a date-based hide puts the entry back with no new
    // information, which is how a queue teaches people to ignore it.
    server.use(followUps(populated));

    renderPage();
    await settled();

    for (const control of screen.getAllByRole("button")) {
      expect(control.textContent ?? "").not.toMatch(/adiar|soneca|lembrar depois|até/i);
    }
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("gives a row action a treatment of its own", async () => {
    server.use(followUps(populated));

    renderPage();
    await settled();

    // Outlined and in the brand colour: a border and a hue the row's body text
    // and MUI's disabled grey both lack.
    const action = screen.getAllByRole("button", { name: "Criar lembrete" })[0] as HTMLElement;
    expect(action).toHaveClass("MuiButton-outlined");
    expect(action).toHaveClass("MuiButton-colorPrimary");
    expect(action).not.toBeDisabled();
    // The reminder chip sits on the same row and must not read as an action.
    const chip = screen.getByText(/2 lembretes · próximo/).closest(".MuiChip-root");
    expect(chip).not.toBeNull();
    expect(chip).not.toHaveClass("MuiButton-outlined");
    // Muted secondary text is not a control at all.
    expect(screen.getByText("previsto 15/07/2026").closest("button")).toBeNull();
  });

  it("states the failure once without drawing a count of zero, then retries", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/follow-ups", ({ request }) => {
        if (new URL(request.url).searchParams.get("closed") === "1") {
          return HttpResponse.json(emptyResult);
        }
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        }
        return HttpResponse.json(emptyResult);
      }),
      // Both reads down: nothing at all is known about this queue.
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderPage();

    expect(
      await screen.findByText("Não foi possível carregar as seções do follow-up"),
    ).toBeInTheDocument();
    // One message. The branch this replaced drew a screen-level alert AND a
    // per-section alert inside each rendered section for the same failed read.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // Nothing is known, so no card claims nothing is pending.
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText("0")).not.toBeInTheDocument();

    await click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Nenhum orçamento sem resposta.")).toBeInTheDocument();
  });

  it("keeps the four counts on screen when only the lists fail", async () => {
    // Counts and lists are separate reads, so a failed list read is not a
    // reason to stop saying how much work is waiting — and a zero would read as
    // "nothing pending" at the moment the rows are exactly what is unknown.
    server.use(
      http.get("*/api/follow-ups", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({
          unansweredQuotes: 1,
          overdueReturns: 1,
          upcomingReturns: 2,
          waitingReply: 1,
        }),
      ),
    );

    renderPage();

    expect(
      await screen.findByText("Não foi possível carregar as seções do follow-up"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { pressed: false }).map((card) => card.textContent),
    ).toEqual([
      "Mensagens aguardando resposta1",
      "Orçamentos sem resposta1",
      "Retorno vencido1",
      "Retorno se aproximando2",
    ]);
    // The counts are held, so no card falls back to the unknown dash.
    expect(screen.queryByText("—")).toBeNull();
    // No section is listed, so no section reports being empty either.
    expect(screen.queryByText("Nenhum orçamento sem resposta.")).toBeNull();
  });

  it("draws real counts on the cards while the section lists are still loading", async () => {
    // The `counts ? <CountCards> : <Skeleton row>` arm inside the loading
    // branch: no prior it had the counts read land while the list read was
    // still pending, so the skeleton-row alternative was the only one ever
    // exercised during isLoading.
    server.use(
      http.get("*/api/follow-ups", async ({ request }) => {
        if (new URL(request.url).searchParams.get("closed") === "1") {
          return HttpResponse.json(emptyResult);
        }
        await delay("infinite");
        return HttpResponse.json(emptyResult);
      }),
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({
          unansweredQuotes: 1,
          overdueReturns: 1,
          upcomingReturns: 2,
          waitingReply: 1,
        }),
      ),
    );

    renderPage();

    // The numbers are already on screen...
    const card = await screen.findByRole("button", { name: /Orçamentos sem resposta/ });
    expect(card).toHaveTextContent("Orçamentos sem resposta1");
    // ...while every section body is still the loading placeholder, which is
    // what proves the list read itself has not resolved yet.
    expect(screen.getAllByText("Carregando follow-up")).toHaveLength(3);
  });
});
