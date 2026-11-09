/**
 * The OpenAI benchmark (switch-oil-research-to-openai tasks 2.1 and 3.3–3.4; design.md D9).
 *
 *   pnpm --filter @select-lub/core exec tsx src/modules/quotes/internal/scripts/benchmark-openai.ts \
 *     --capture <capture-oil-benchmark.json> [--run] [--report <report.json>] \
 *     [--search-identity "<make>|<year>|<model>|<version>"]...
 *
 * A dry run is the default: it prints the plan — cases per group, calls, the effective caps, the
 * expected and the worst-case cost — and makes no network call. Show it to the orchestrator; a
 * paid run needs `--run` and `OPENAI_API_KEY`, and spends at most US$ 1.00 on OpenAI calls only.
 *
 * `--search-identity` is repeatable and adds a car to the search group (c), beside the captured
 * unverified ones. Each value has four non-empty parts, the year a 4-digit integer, for example
 * `--search-identity "Toyota|2019|Corolla|XEi 2.0"`. At most 5 searches in total, the captured
 * failing car included; more, or a repeated car, refuses to start.
 *
 * Caps: the stored-passage group (a) keeps US$ 0.20 and the manual-reading group (b) US$ 0.30, but
 * only when they have cases. A group with no cases releases its cap, so the searches (c) may spend
 * US$ 1.00 minus the caps (a) and (b) keep, up to the whole US$ 1.00. The dry run prints them.
 *
 * Every model call it makes is OpenAI's: its transport refuses any other host. This entry runs its
 * guards BEFORE importing the paid run, so a dry run never loads a model client, and the paid run
 * re-checks after its imports (an imported module may load a `.env`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { benchmarkMain, refusal, type BenchmarkArgs, type BenchmarkCase, type BenchmarkPlan } from "./benchmark-plan.js";

const code = await benchmarkMain(process.argv.slice(2), {
  env: process.env,
  readFile: (path) => readFileSync(path, "utf8"),
  log: (line) => console.log(line),
  runPaid: async (cases: BenchmarkCase[], plan: BenchmarkPlan, args: BenchmarkArgs) => {
    const { runBenchmark } = await import("./benchmark-openai-run.js");
    const why = refusal(args, process.env);
    if (why) throw new Error(`benchmark: refusing after imports — ${why}`);
    const report = await runBenchmark(cases, plan, args);
    const out = JSON.stringify(report, null, 2);
    if (args.report) writeFileSync(args.report, out);
    console.log(`benchmark: spent US$ ${report.spentUsd.total.toFixed(4)} (a ${report.spentUsd.a.toFixed(4)}, b ${report.spentUsd.b.toFixed(4)}, c ${report.spentUsd.c.toFixed(4)})`);
  },
});
process.exitCode = code;
