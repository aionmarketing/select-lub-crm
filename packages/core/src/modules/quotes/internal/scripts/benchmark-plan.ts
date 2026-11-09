/**
 * The OpenAI benchmark's plan, its caps and its start-up guards (switch-oil-research-to-openai
 * task 2.1, design.md D9). Pure: no network, no database, no model client. The dry run is this
 * module alone; a paid run (`--run`) imports `benchmark-openai-run.ts` only after these guards.
 *
 * The rules, owner-approved 2026-10-11:
 * - OpenAI only: `gpt-6.1-sol` at `medium`. The comparison side — what GLM stored in production,
 *   before GLM was removed — is read from the capture; nothing is re-run on it.
 * - A hard US$ 1.00 cap over OpenAI calls, with group caps (a) stored passages US$ 0.20,
 *   (b) manual readings US$ 0.30, (c) OpenAI searches US$ 0.50, run in that order. A group with no
 *   cases releases its cap to the searches (owner, 2026-10-12): see {@link effectiveCaps}. The
 *   case-driven groups keep their own caps.
 * - Before EVERY call, the spend so far plus that call's worst case must fit its group's cap and
 *   the total ({@link CapGuard}). The worst case is the input estimate at US$ 2/M (plus the tool's whole 128,000-token
 *   search window for a search call), a 12,000-token output reservation at US$ 10/M, and
 *   the tool fees up to `max_tool_calls`.
 * - The comparison side is what GLM already stored in production: the capture (one read-only
 *   query the owner runs, design.md D9). Nothing is re-run on GLM.
 */
import { parseCapture, parseSearchIdentity, passageCases, readingCases, searchCases, type BenchmarkCapture, type BenchmarkCase } from "./benchmark-cases.js";
import type { VehicleIdentity } from "../store/store.js";

/** The hard total cap, USD, over OpenAI calls only. Approved by the owner 2026-10-11. */
export const BENCHMARK_TOTAL_CAP_USD = 1.0;

/** The three groups, in run order, with their caps (design.md D9). */
export const BENCHMARK_GROUPS = [
  { id: "a", label: "stored passages", capUsd: 0.2 },
  { id: "b", label: "manual readings", capUsd: 0.3 },
  { id: "c", label: "OpenAI searches", capUsd: 0.5 },
] as const;

/** A group id. */
export type GroupId = (typeof BENCHMARK_GROUPS)[number]["id"];

/** The cap each group may spend in a run, USD. */
export type Caps = Record<GroupId, number>;

/** The groups' own caps, with no case counts known. */
export const STATIC_CAPS: Caps = { a: 0.2, b: 0.3, c: 0.5 };

/**
 * The caps a run enforces (owner, 2026-10-12). A case-driven group, (a) or (b), keeps its own cap
 * when it has cases and has none (0) when it has not. The searches, (c), get the total minus the
 * caps the case-driven groups keep, so a group with nothing to do releases its cap to the searches.
 * The total never moves: the caps always add up to at most {@link BENCHMARK_TOTAL_CAP_USD}.
 *
 * @param cases - The number of cases per group.
 */
export function effectiveCaps(cases: Readonly<Record<GroupId, number>>, totalCapUsd = BENCHMARK_TOTAL_CAP_USD): Caps {
  const a = cases.a > 0 ? STATIC_CAPS.a : 0;
  const b = cases.b > 0 ? STATIC_CAPS.b : 0;
  const c = cases.c > 0 ? Math.max(0, totalCapUsd - a - b) : 0;
  return { a, b, c };
}

/** The output reservation every benchmark call is sent as `max_output_tokens` (benchmark only). */
export const BENCHMARK_OUTPUT_RESERVATION_TOKENS = 12_000;

/** The search-content tokens a search call's worst case adds: the tool's whole 128K search window (web-search guide), so no admitted call can pass a cap. */
export const BENCHMARK_SEARCH_CONTENT_TOKENS = 128_000;

/** gpt-6.1-sol's list, USD per million tokens (OpenAI pricing page, 2026-10-10). */
export const BENCHMARK_PRICE = { input: 2, output: 10, toolCallUsd: 0.01 } as const;

/** Characters per token the worst case assumes: fewer than real text, so an over-estimate. */
export const WORST_CASE_CHARS_PER_TOKEN = 3;

export * from "./benchmark-cases.js";

// ---------------------------------------------------------------------------------------------
// Estimates and the plan.
// ---------------------------------------------------------------------------------------------

/** A US$ range. */
export type Range = { low: number; high: number };

/** The system prompt and framing every extraction sends, in characters (about 3,000). */
const EXTRACTION_OVERHEAD_CHARS = 3_000;

const usd = (inputTokens: number, outputTokens: number) => (inputTokens * BENCHMARK_PRICE.input + outputTokens * BENCHMARK_PRICE.output) / 1e6;

/** One case's expected cost, from its own text and design.md D4's per-call token ranges. */
export function expectedCaseUsd(entry: BenchmarkCase): Range {
  if (entry.group === "a") {
    const input = (EXTRACTION_OVERHEAD_CHARS + (entry.source.excerpt?.length ?? 0)) / 4;
    // A long page also goes through passage selection first (one more call over the same text).
    const calls = (entry.source.excerpt?.length ?? 0) > 3_000 ? 2 : 1;
    return { low: calls * usd(input, 500), high: calls * usd(input, 2_000) };
  }
  if (entry.group === "b") {
    const input = (EXTRACTION_OVERHEAD_CHARS + entry.locatedChars) / 4;
    return { low: usd(input, 1_000) + usd(input / 2, 1_000), high: usd(input, 2_000) + usd(input, 3_000) };
  }
  return { low: 0.05, high: 0.13 };
}

/** The caps a plan enforces, per group: what the dry run printed is what the paid run's {@link CapGuard} is given. */
export function capsOfPlan(plan: { groups: ReadonlyArray<{ id: GroupId; capUsd: number }> }): Caps {
  const caps: Caps = { a: 0, b: 0, c: 0 };
  for (const group of plan.groups) caps[group.id] = group.capUsd;
  return caps;
}

/** The plan the dry run prints and the orchestrator approves. */
export type BenchmarkPlan = {
  model: string;
  effort: string;
  totalCapUsd: number;
  groups: Array<{
    id: GroupId;
    label: string;
    /** The cap this run enforces: the group's own, or for the searches the total minus the caps (a) and (b) keep. */
    capUsd: number;
    /** The group's own cap before any release. */
    ownCapUsd: number;
    cases: number;
    calls: Range;
    expectedUsd: Range;
    /** What the cap lets through at the expected high, never more than the group cap. */
    expectedWithinCapUsd: Range;
    worstCasePerCallUsd: number;
  }>;
  expectedTotalUsd: Range;
  /** The first call, B0: the web_search tool on gpt-6.1-sol, before anything else is spent. */
  firstCall: string;
};

/** The worst case of one call with `inputChars` of body, as {@link CapGuard} counts it. */
export function worstCaseUsd(inputChars: number, search: { maxToolCalls: number } | null): number {
  const inputTokens = Math.ceil(inputChars / WORST_CASE_CHARS_PER_TOKEN) + (search ? BENCHMARK_SEARCH_CONTENT_TOKENS : 0);
  return usd(inputTokens, BENCHMARK_OUTPUT_RESERVATION_TOKENS) + (search ? search.maxToolCalls * BENCHMARK_PRICE.toolCallUsd : 0);
}

/** Builds the plan from the capture. */
export function buildPlan(
  capture: BenchmarkCapture,
  model = "gpt-6.1-sol",
  effort = "medium",
  extraSearches: readonly VehicleIdentity[] = [],
): { plan: BenchmarkPlan; cases: BenchmarkCase[] } {
  const a = passageCases(capture.cache_rows);
  const b = readingCases(capture.manual_readings, capture.manual_documents);
  const c = searchCases(capture.identities, extraSearches);
  const cases: BenchmarkCase[] = [...a, ...b, ...c];
  const sum = (list: readonly BenchmarkCase[]) =>
    list.reduce<Range>((acc, entry) => {
      const r = expectedCaseUsd(entry);
      return { low: acc.low + r.low, high: acc.high + r.high };
    }, { low: 0, high: 0 });
  const calls: Record<GroupId, Range> = {
    a: { low: a.length, high: a.reduce((n, entry) => n + ((entry.source.excerpt?.length ?? 0) > 3_000 ? 2 : 1), 0) },
    b: { low: b.length * 2, high: b.length * 2 },
    // B0, then per search: the search, the classification, up to 3 page reads' selection and extraction.
    c: { low: c.length > 0 ? 1 + c.length * 2 : 0, high: c.length > 0 ? 1 + c.length * 8 : 0 },
  };
  const longest = (list: readonly BenchmarkCase[]) =>
    Math.max(
      0,
      ...list.map((entry) =>
        entry.group === "a" ? (entry.source.excerpt?.length ?? 0) : entry.group === "b" ? entry.locatedChars : 4_000,
      ),
    );
  const caps = effectiveCaps({ a: a.length, b: b.length, c: c.length });
  const groups = BENCHMARK_GROUPS.map((group) => {
    const list = cases.filter((entry) => entry.group === group.id);
    const expected = sum(list);
    const capUsd = caps[group.id];
    return {
      id: group.id,
      label: group.label,
      capUsd,
      ownCapUsd: group.capUsd,
      cases: list.length,
      calls: calls[group.id],
      expectedUsd: expected,
      expectedWithinCapUsd: { low: Math.min(expected.low, capUsd), high: Math.min(expected.high, capUsd) },
      worstCasePerCallUsd: worstCaseUsd(EXTRACTION_OVERHEAD_CHARS + longest(list), group.id === "c" ? { maxToolCalls: 3 } : null),
    };
  });
  const expectedTotalUsd = groups.reduce<Range>(
    (acc, group) => ({ low: acc.low + group.expectedWithinCapUsd.low, high: acc.high + group.expectedWithinCapUsd.high }),
    { low: 0, high: 0 },
  );
  return {
    plan: {
      model,
      effort,
      totalCapUsd: BENCHMARK_TOTAL_CAP_USD,
      groups,
      expectedTotalUsd: { low: Math.min(expectedTotalUsd.low, BENCHMARK_TOTAL_CAP_USD), high: Math.min(expectedTotalUsd.high, BENCHMARK_TOTAL_CAP_USD) },
      firstCall: c.length > 0 ? "B0: one web_search call on gpt-6.1-sol, max_tool_calls 1, before any other call" : "B0 skipped: no identity to search",
    },
    cases,
  };
}

/** The plan as the lines the dry run prints. */
export function formatPlan(plan: BenchmarkPlan): string[] {
  const money = (n: number) => `US$ ${n.toFixed(3)}`;
  const lines = [
    `benchmark: ${plan.model} at ${plan.effort}; OpenAI only; hard cap ${money(plan.totalCapUsd)}`,
    `benchmark: ${plan.firstCall}`,
  ];
  const note = (g: BenchmarkPlan["groups"][number]) =>
    g.cases === 0 ? " (no cases, released)" : g.capUsd !== g.ownCapUsd ? ` (own ${money(g.ownCapUsd)}, plus the released caps)` : "";
  lines.push(`benchmark: effective caps — ${plan.groups.map((g) => `(${g.id}) ${money(g.capUsd)}${note(g)}`).join("; ")}`);
  for (const g of plan.groups) {
    lines.push(
      `  (${g.id}) ${g.label}: ${g.cases} cases, ${g.calls.low}–${g.calls.high} calls, expected ${money(g.expectedUsd.low)}–${money(g.expectedUsd.high)}` +
        ` (within its ${money(g.capUsd)} cap: ${money(g.expectedWithinCapUsd.low)}–${money(g.expectedWithinCapUsd.high)}), worst case per call ${money(g.worstCasePerCallUsd)}`,
    );
  }
  lines.push(`  total expected ${money(plan.expectedTotalUsd.low)}–${money(plan.expectedTotalUsd.high)}; every call is refused before it is sent when spent + its worst case would pass its group cap or ${money(plan.totalCapUsd)}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The cap guard: checked before every call.
// ---------------------------------------------------------------------------------------------

/** A call the cap refused before it was sent. */
export class BenchmarkCapReached extends Error {
  override name = "BenchmarkCapReached";
}

/** Counts spend per group and refuses a call whose worst case would pass a cap. */
export class CapGuard {
  private readonly spent: Record<GroupId, number> = { a: 0, b: 0, c: 0 };

  /**
   * @param totalCapUsd - The hard total.
   * @param caps - The group caps this run enforces ({@link effectiveCaps}); the groups' own caps by default.
   */
  constructor(
    private readonly totalCapUsd = BENCHMARK_TOTAL_CAP_USD,
    private readonly caps: Caps = STATIC_CAPS,
  ) {}

  /** The total spent so far. */
  total(): number {
    return this.spent.a + this.spent.b + this.spent.c;
  }

  /** Spent in one group. */
  group(id: GroupId): number {
    return this.spent[id];
  }

  /**
   * Throws {@link BenchmarkCapReached} when `worstUsd` does not fit the group's cap and the total.
   *
   * @param id - The call's group.
   * @param worstUsd - The call's worst case ({@link worstCaseUsd}).
   */
  admit(id: GroupId, worstUsd: number): void {
    const cap = this.caps[id];
    if (this.spent[id] + worstUsd > cap + 1e-9) {
      throw new BenchmarkCapReached(`group (${id}) cap: spent US$ ${this.spent[id].toFixed(4)} + worst case US$ ${worstUsd.toFixed(4)} > US$ ${cap.toFixed(2)}`);
    }
    if (this.total() + worstUsd > this.totalCapUsd + 1e-9) {
      throw new BenchmarkCapReached(`total cap: spent US$ ${this.total().toFixed(4)} + worst case US$ ${worstUsd.toFixed(4)} > US$ ${this.totalCapUsd.toFixed(2)}`);
    }
  }

  /** Sets what a group has spent, from the meter. */
  set(id: GroupId, usdSpent: number): void {
    this.spent[id] = usdSpent;
  }
}

// ---------------------------------------------------------------------------------------------
// The start-up guards and the entry's flow, injectable so a test can drive them with no network.
// ---------------------------------------------------------------------------------------------

/** What the entry was asked. */
export type BenchmarkArgs = { run: boolean; capture: string | null; report: string | null; searchIdentities: VehicleIdentity[] };

/**
 * Parses `--run`, `--dry-run`, `--capture <file>`, `--report <file>` and the repeatable
 * `--search-identity "<make>|<year>|<model>|<version>"`. Dry run is the default.
 */
export function parseArgs(argv: readonly string[]): BenchmarkArgs {
  const args: BenchmarkArgs = { run: false, capture: null, report: null, searchIdentities: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") args.run = true;
    else if (arg === "--dry-run") args.run = false;
    else if (arg === "--capture") args.capture = argv[++i] ?? null;
    else if (arg === "--report") args.report = argv[++i] ?? null;
    else if (arg === "--search-identity") args.searchIdentities.push(parseSearchIdentity(argv[++i] ?? ""));
    else throw new Error(`benchmark: unknown argument ${arg}`);
  }
  return args;
}

/** Why the benchmark will not start, or `null`. */
export function refusal(args: BenchmarkArgs, env: NodeJS.ProcessEnv): string | null {
  if (!args.capture) return "--capture <file> is required";
  if (args.run && !env.OPENAI_API_KEY?.trim()) return "--run needs OPENAI_API_KEY";
  return null;
}

/** The entry's flow. `runPaid` is only reached with `--run`. */
export async function benchmarkMain(
  argv: readonly string[],
  deps: {
    env: NodeJS.ProcessEnv;
    readFile: (path: string) => string;
    log: (line: string) => void;
    runPaid: (cases: BenchmarkCase[], plan: BenchmarkPlan, args: BenchmarkArgs) => Promise<void>;
  },
): Promise<number> {
  let args: BenchmarkArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    deps.log(String(err));
    return 2;
  }
  const why = refusal(args, deps.env);
  if (why) {
    deps.log(`benchmark: refusing — ${why}`);
    return 2;
  }
  const capture = parseCapture(deps.readFile(args.capture!));
  let built: ReturnType<typeof buildPlan>;
  try {
    built = buildPlan(capture, undefined, undefined, args.searchIdentities);
  } catch (err) {
    deps.log(`benchmark: refusing — ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { plan, cases } = built;
  for (const line of formatPlan(plan)) deps.log(line);
  if (!args.run) {
    deps.log("benchmark: dry run — no call made. Show this plan to the orchestrator; a paid run needs --run.");
    return 0;
  }
  await deps.runPaid(cases, plan, args);
  return 0;
}
