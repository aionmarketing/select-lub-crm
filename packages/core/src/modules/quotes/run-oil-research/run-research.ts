/**
 * One claimed research run (background-oil-research D8â€“D12): the identity-level pipeline over
 * the run's ports, outside any transaction; then, by what stopped it or what it returned, a
 * release, a provider pause, or D10's recorded outcome â€” with the manual wait (D11) and the
 * Tecfil step (D12) after a verified record.
 *
 * Record or release is decided by the signals, never by what the pipeline returned: an aborted
 * call returns an ordinary failure value, which must not become an outcome.
 */
import type { Db } from "../../../kernel/db.js";
import { resolveOilSpec, type OilSpecPorts, type OilSpecResult, type RetrievedSource, type SourceAuthority } from "../internal/pipeline/oil-spec.js";
import type { StoredPassage } from "../internal/research/outcome.js";
import { currentWebSource } from "../internal/research/current-answer.js";
import { manualStillToCome, queueIdentityManuals } from "../internal/research/manual-wait.js";
import { persistManualCandidates } from "../internal/research/manual-candidates.js";
import { mapPipelineResult, type MappedOutcome } from "../internal/research/outcome.js";
import type { OilResearchPorts, ResearchRunContext } from "../internal/research/ports.js";
import { collectRefusals, type RunRefusals } from "../internal/research/provider-events.js";
import {
  recordResearch,
  releaseResearch,
  renewResearchLease,
  type ResearchClaim,
  type ResearchRecord,
  type TecfilClaim,
} from "../internal/research/research-store.js";
import { isMotulDegraded, pauseForProvider, readMotulFailingSince, recordMotulOutcome } from "../internal/research/runner-row.js";
import { researchLeaseMs, runCeilingMs, type OilResearchSettings } from "../internal/research/settings.js";
import { storePerCall } from "../internal/research/store-per-call.js";
import { compatibilityCaches } from "../internal/store/compatibility-caches.js";
import { UNVERIFIED_SEARCH_REASON, type MotulOutcome } from "../internal/retrieval/sources.js";
import { guardRun, type GuardedRun } from "./guarded-run.js";
import type { OutageBreaker } from "./outage-breaker.js";
import { runTecfilClaim, type TecfilRunOutcome } from "./run-tecfil.js";

/** What the runner is built on. */
export type RunnerDeps = {
  db: Db;
  ports: OilResearchPorts;
  settings: OilResearchSettings;
  now: () => Date;
  breaker: OutageBreaker;
};

/** How a research run ended. */
export type ResearchRunResult = {
  /** The run row's outcome, or `released` / `lost`. */
  outcome: string;
  /** The row's state afterwards, when recorded. */
  state?: string;
  /** A provider-wide refusal or the breaker paused research. */
  paused?: "provider" | "breaker";
  tecfil?: TecfilRunOutcome;
};

function log(claim: ResearchClaim, detail: Record<string, unknown>): void {
  console.info("oil-research", JSON.stringify({ identity: claim.identityKey, run: claim.runId, kind: claim.kind, attempt: claim.attempts, ...detail }));
}

/** Every port call goes through the run's `step`: the lease renewed, the meter flushed, the stage timed. */
function steppedPorts(ports: OilSpecPorts, run: GuardedRun, extra: RetrievedSource | null): OilSpecPorts {
  return {
    retrieve: async (identity, options) => {
      const found = await run.step(null, () => ports.retrieve(identity, options));
      if (!extra) return found;
      // The re-resolve's second source: the page behind the current answer (D11).
      if (found.status === "found") return { ...found, sources: [...found.sources, extra] };
      if (found.status === "none") return { status: "found", sources: [extra], ...(found.manualCandidates ? { manualCandidates: found.manualCandidates } : {}) };
      return found;
    },
    extract: (source, identity) => run.step("extraction", () => ports.extract(source, identity)),
    ...(ports.selectPassage ? { selectPassage: (source, identity) => run.step("passage", () => ports.selectPassage!(source, identity)) } : {}),
    ...(ports.escalate ? { escalate: (input) => run.step("escalation", () => ports.escalate!(input)) } : {}),
  };
}

/**
 * The passages an engine pick copied (D24) as one source: the highest-authority passage's
 * citation, the texts joined in order with one `[…]` line between them, so a single extraction
 * reads them all.
 */
export function enginePickSource(passages: readonly StoredPassage[]): RetrievedSource {
  const ordered = [...passages].sort((a, b) => (a.tier ?? 6) - (b.tier ?? 6));
  const top = ordered[0]!;
  const text = ordered.map((passage) => passage.excerpt).join("\n[…]\n");
  return {
    publisher: top.publisher,
    document: top.document,
    page: top.page,
    ...(top.tier != null ? { authority: top.tier as SourceAuthority } : {}),
    ...(top.url ? { url: top.url } : {}),
    ...(top.classification ? { classification: top.classification } : {}),
    excerpt: text,
    // The copy is the whole reading: it never spares or asks for a web search.
    content: { kind: "text", text },
  };
}

/**
 * An engine pick's ports: retrieval answers the copied passages with no provider call, and the
 * extractor is the run's own, stepped like any call. No passage selector (the text already is
 * the passage) and no escalation (one source).
 */
function enginePickPorts(ports: OilSpecPorts, run: GuardedRun, pick: { engine: string; passages: readonly StoredPassage[] }): OilSpecPorts {
  const source = enginePickSource(pick.passages);
  return {
    retrieve: () => run.step(null, async () => ({ status: "found", sources: [source] })),
    // The picked engine always reaches the extractor, so a version that already names it is not
    // a futile re-read of the passage that asked (orchestrator, 2026-10-01).
    extract: (candidate, identity) => run.step("extraction", () => ports.extract(candidate, { ...identity, engine: pick.engine })),
  };
}

/**
 * Runs one claim.
 *
 * @param stop - The job's stop signal: its abort releases the claim at once.
 */
export async function runResearchClaim(deps: RunnerDeps, claim: ResearchClaim, stop: AbortSignal): Promise<ResearchRunResult> {
  const { db, settings } = deps;
  const leaseMs = researchLeaseMs();
  const ceilingMs = runCeilingMs(settings);
  const startedAt = Date.now();
  const run = guardRun(
    db,
    {
      renew: (tx, now, progress) => renewResearchLease(tx, claim, now, leaseMs, progress),
      release: (tx, now, progress) => releaseResearch(tx, claim, { now, ...progress }),
    },
    { stop, ceilingMs, now: deps.now },
  );
  let ran: { result: ResearchRunResult; tecfil: TecfilClaim | null };
  try {
    ran = await researchAndRecord(deps, claim, run, leaseMs);
  } finally {
    await run.settle();
  }
  // The Tecfil step, on the claim the verified record took over, once the research frame closed:
  // the same run row, meter and stage times (D9, step 8), under what remains of the run ceiling.
  // Always through the Tecfil claim's own frame, even when the worker is already stopping: that
  // frame releases the taken-over claim at once, its Tecfil attempt refunded (D19).
  if (ran.tecfil) {
    const stageMs = { ...run.progress().stageMs };
    const remainingMs = Math.max(0, ceilingMs - (Date.now() - startedAt));
    const tecfil = await runTecfilClaim({ db, ports: deps.ports, now: deps.now, ceilingMs: remainingMs }, ran.tecfil, stop, { meter: run.meter, stageMs });
    return { ...ran.result, tecfil };
  }
  return ran.result;
}

async function researchAndRecord(
  deps: RunnerDeps,
  claim: ResearchClaim,
  run: GuardedRun,
  leaseMs: number,
): Promise<{ result: ResearchRunResult; tecfil: TecfilClaim | null }> {
  const outcome = (result: ResearchRunResult, tecfil: TecfilClaim | null = null) => ({ result, tecfil });
  const { db, settings } = deps;
  const refusals = collectRefusals();
  const pick = claim.kind === "engine_pick" ? claim.enginePick : null;
  const skipWebSearch = claim.kind === "manual_resolve" || pick !== null;
  // Motul's long outage is a state, not an incident (oil-research-web-retrieval D6): read before the
  // ports are built, so the Motul adapter knows whether its `unavailable` still counts.
  const motulDegraded = isMotulDegraded(await db.tx("quotes", (tx) => readMotulFailingSince(tx)), deps.now(), settings.motulDegradedAfterMs);
  const motul: { outcome: MotulOutcome | null } = { outcome: null };
  const ctx: ResearchRunContext = {
    meter: run.meter,
    signal: run.signal,
    step: run.step,
    report: refusals.report,
    skipWebSearch,
    motulDegraded,
    reportMotul: (outcome) => {
      motul.outcome = outcome;
    },
  };

  // A re-resolve reads the page behind the current answer (D11), and keeps whether the cycle's
  // stage 1 searched the web: a no-source it records must not claim a search it never made (D10).
  const resolve = claim.kind === "manual_resolve"
    ? await db.tx("quotes", async (tx) => ({
        latest: await compatibilityCaches(tx).latestCompatibility(claim.identity),
        searched: (await tx.oilResearch.findUnique({ where: { id: claim.id }, select: { searched: true } }))?.searched ?? true,
      }))
    : null;
  const extra = resolve ? currentWebSource(resolve.latest) : null;
  // An engine pick re-reads only the passages copied onto its row, for its engine: one extraction,
  // no search, fetch, Motul call, passage selection or escalation (D24).
  const ports = pick ? enginePickPorts(deps.ports.specPorts(ctx), run, pick) : steppedPorts(deps.ports.specPorts(ctx), run, extra);
  // When this run loaded the stored readings: the manual-upgrade check compares with it (D11).
  const sourcesReadAt = deps.now();
  // A throw — a step refused because the run was stopped, lost or past its ceiling — is no result.
  const resolved: OilSpecResult | null = await resolveOilSpec(claim.identity, ports, { forceWebSearch: claim.kind === "refetch" }).catch(() => null);

  const why = run.interrupted();
  if (why === "stopped") {
    const { released } = await run.settle();
    log(claim, { outcome: released ? "released" : "lost", why: "stopped" });
    return outcome({ outcome: released ? "released" : "lost" });
  }
  if (why === "lost") {
    log(claim, { outcome: "lost" });
    return outcome({ outcome: "lost" });
  }

  // Insert-only evidence of what the search saw, whatever the outcome (D9, step 7).
  if (resolved) {
    const store = storePerCall(db);
    await persistManualCandidates(store, claim.identity, resolved.manualCandidates);
    if (resolved.webFoundUnverified) {
      await store.recordSearchMiss({ ...claim.identity, reason: UNVERIFIED_SEARCH_REASON, searchedAt: resolved.webFoundUnverified.searchedAt });
    }
  }

  const heard = refusals.heard();
  const now = deps.now();
  if (heard.provider) return outcome(await pauseForRefusal(deps, claim, run, heard));
  const hurt = resolved === null || resolved.status !== "verified";
  if (heard.rateLimit && hurt && why !== "ceiling") return outcome(await releaseForRateLimit(deps, claim, run, heard));

  let mapped: MappedOutcome;
  if (why === "ceiling" || resolved === null) {
    mapped = { kind: "transient" };
  } else {
    mapped = mapPipelineResult(resolved, claim.identity, now);
    if (heard.refusedParameter && mapped.kind !== "verified") {
      // A refused request parameter is an outage of this run, its body logged (D9).
      log(claim, { refused_parameter: heard.refusedParameter.status, code: heard.refusedParameter.code, body: heard.refusedParameter.body });
      mapped = mapped.kind === "transient" ? mapped : { kind: "transient" };
    }
  }

  if (mapped.kind === "no_spec" && resolve) mapped = { kind: "no_spec", searched: resolve.searched };
  // An engine re-read searched nothing, like a re-resolve that skipped the web (orchestrator, 2026-10-01).
  if (mapped.kind === "no_spec" && pick) mapped = { kind: "no_spec", searched: false };
  // Nor did it load the stored readings, so it moves no `sources_read_at` (D11's upgrade check).
  let record = toRecord(mapped, pick ? null : sourcesReadAt);
  if (pick?.reopened && mapped.kind !== "verified" && (mapped.kind !== "transient" || claim.attempts >= settings.maxAttempts)) {
    // G2: a re-read that reopened a resting outcome and did not verify keeps that outcome, dated by this run.
    record = { outcome: "kept_prior", runOutcome: mapped.kind === "transient" ? (mapped.fallback?.outcome ?? "failed") : mapped.kind };
  }
  const options = { now, leaseMs, maxAttempts: settings.maxAttempts, ...run.progress() };
  const recorded = await db.tx("quotes", async (tx) => {
    if (record.outcome === "no_spec" && record.searched && !skipWebSearch) {
      // Stage 1 searched and found nothing: queue this identity's manuals, and wait while one is
      // to come (D11). A stage 1 that could not search rests `searched: false` instead, so the next
      // quote-open reopens it at once (D10; review of #186).
      await queueIdentityManuals(tx, claim.identity);
      if (settings.manualIngestion && (await manualStillToCome(tx, claim.identityKey))) {
        return recordResearch(tx, claim, { outcome: "waiting_manual", waitUntil: new Date(now.getTime() + settings.manualWaitMs) }, options);
      }
    }
    if (record.outcome === "transient" && settings.manualIngestion && !skipWebSearch) {
      // An outage or a failed last attempt still found its manual: queue it for reading, without
      // waiting — waiting is for an identity whose search completed. A verified reading resolves
      // the identity again through the manual-upgrade check (oil-research-web-retrieval D5).
      await queueIdentityManuals(tx, claim.identity);
    }
    return recordResearch(tx, claim, record, options);
  });
  if (recorded.status === "lost") {
    log(claim, { outcome: "lost" });
    return outcome({ outcome: "lost" });
  }
  // What Motul came to, stamped or cleared now that the run is recorded; a released or lost run writes nothing.
  if (motul.outcome) await db.tx("quotes", (tx) => recordMotulOutcome(tx, motul.outcome!, now));
  let paused: ResearchRunResult["paused"];
  if (mapped.kind === "transient") {
    if (deps.breaker.outage(claim.identityKey)) {
      await db.tx("quotes", (tx) => pauseForProvider(tx, now, new Date(now.getTime() + settings.providerPauseMs)));
      paused = "breaker";
    }
  } else {
    deps.breaker.reset();
  }
  const motulLog = motul.outcome === "unavailable" && motulDegraded ? "degraded" : motul.outcome;
  log(claim, { outcome: recorded.runOutcome, state: recorded.state, ...(why === "ceiling" ? { why: "ceiling" } : {}), ...(paused ? { paused } : {}), ...(motulLog ? { motul: motulLog } : {}) });
  return outcome({ outcome: recorded.runOutcome, state: recorded.state, ...(paused ? { paused } : {}) }, recorded.tecfil);
}

function toRecord(mapped: MappedOutcome, sourcesReadAt: Date | null): ResearchRecord {
  switch (mapped.kind) {
    case "verified":
      return { outcome: "verified", cacheRow: mapped.cacheRow, sourcesReadAt, incomplete: mapped.incomplete };
    case "no_spec":
      return { outcome: "no_spec", searched: mapped.searched, sourcesReadAt };
    case "needs_clarification":
    case "conflicting_sources":
      return { outcome: mapped.kind, payload: mapped.payload, sourcesReadAt };
    case "transient":
      return { outcome: "transient", ...(mapped.fallback ? { fallback: mapped.fallback } : {}), sourcesReadAt };
  }
}

/** A refused key or an exhausted balance: released with the attempt unspent, and research paused (D9). */
async function pauseForRefusal(deps: RunnerDeps, claim: ResearchClaim, run: GuardedRun, heard: RunRefusals): Promise<ResearchRunResult> {
  const now = deps.now();
  const until = new Date(now.getTime() + deps.settings.providerPauseMs);
  const released = await deps.db.tx("quotes", async (tx) => {
    const held = await releaseResearch(tx, claim, { now, ...run.progress() });
    if (held) await pauseForProvider(tx, now, until);
    return held;
  });
  log(claim, { outcome: released ? "released" : "lost", paused: "provider", status: heard.provider?.status, code: heard.provider?.code });
  return released ? { outcome: "released", paused: "provider" } : { outcome: "lost" };
}

/** A rate limit that survived the retries: released, due at its `Retry-After` or in 60 s, and an outage for the breaker (D8). */
async function releaseForRateLimit(deps: RunnerDeps, claim: ResearchClaim, run: GuardedRun, heard: RunRefusals): Promise<ResearchRunResult> {
  const now = deps.now();
  const dueAt = new Date(now.getTime() + (heard.rateLimit?.retryAfterMs ?? 60_000));
  const released = await deps.db.tx("quotes", (tx) => releaseResearch(tx, claim, { now, dueAt, ...run.progress() }));
  if (!released) return { outcome: "lost" };
  let paused: ResearchRunResult["paused"];
  if (deps.breaker.outage(claim.identityKey)) {
    await deps.db.tx("quotes", (tx) => pauseForProvider(tx, now, new Date(now.getTime() + deps.settings.providerPauseMs)));
    paused = "breaker";
  }
  log(claim, { outcome: "released", why: "rate_limit", dueAt: dueAt.toISOString(), ...(paused ? { paused } : {}) });
  return { outcome: "released", ...(paused ? { paused } : {}) };
}
