/**
 * Gitignored mix summary for operators: what each `SEED` thread is about.
 *
 * The builder never receives a phone, chat key, or message body, so those cannot
 * appear in the file even if a caller later adds columns to the seed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One conversation that received a `SEED` thread. */
export type ThreadMixRow = {
  readonly displayName: string;
  readonly blurb: string;
  readonly seedCount: number;
  readonly archetypes: readonly string[];
};

export type ThreadMixSummary = {
  readonly unfilled: readonly { readonly archetype: string; readonly reason: string }[];
  readonly threads: readonly ThreadMixRow[];
};

const PHONE_RUN = /\d{8,15}/;

/**
 * Default path: repo-root `artifacts/demo-seed/thread-mix.md`.
 *
 * Resolved from this file (`packages/core/prisma/seed`) so tests can override.
 */
export function defaultThreadMixPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../artifacts/demo-seed/thread-mix.md");
}

/**
 * Builds the markdown. Names are fake (or pré-cadastro); never phones or bodies.
 *
 * @param summary - Assignment result plus counts from the same planned inserts.
 */
export function buildThreadMixMarkdown(summary: ThreadMixSummary) {
  const lines: string[] = ["# Mix de threads da demo", ""];
  lines.push("## Arquétipos sem conversa");
  lines.push("");
  if (summary.unfilled.length === 0) {
    lines.push("Nenhum. O lote deu para preencher todos.");
  } else {
    for (const row of summary.unfilled) {
      lines.push(`- ${row.archetype}: ${row.reason}`);
    }
  }
  lines.push("", "## Threads", "");
  if (summary.threads.length === 0) {
    lines.push("Nenhuma conversa recebeu thread `SEED`.");
  } else {
    for (const row of summary.threads) {
      lines.push(`### ${row.displayName}`);
      lines.push("");
      lines.push(row.blurb);
      lines.push("");
      lines.push(`- mensagens SEED: ${row.seedCount}`);
      lines.push(`- arquétipos: ${row.archetypes.join(", ")}`);
      lines.push("");
    }
  }
  const markdown = `${lines.join("\n").trimEnd()}\n`;
  if (PHONE_RUN.test(markdown)) {
    throw new Error("thread-mix markdown would include a phone-like digit run");
  }
  return markdown;
}

/**
 * Overwrites the mix file. No-op when demo seed is skipped.
 *
 * @param enabled - `isDemoSeedEnabled()`; false must not create or touch the file.
 * @param summary - Same assignment the inserts used.
 * @param filePath - Defaults to {@link defaultThreadMixPath}.
 */
export async function writeThreadMixSummaryIfEnabled(
  enabled: boolean,
  summary: ThreadMixSummary,
  filePath = defaultThreadMixPath(),
) {
  if (!enabled) {
    return { wrote: false, filePath };
  }
  const markdown = buildThreadMixMarkdown(summary);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, "utf8");
  console.log(`seed: wrote ${filePath}`);
  return { wrote: true, filePath };
}
