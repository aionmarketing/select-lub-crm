/**
 * CLI: `pnpm --filter @select-lub/core tidsci:generate`
 *
 * Reads `tid_archive` via `TID_ARCHIVE_DATABASE_URL`, parses catalog materials
 * (OpenAI + gitignored cache), and writes `.local/tidsci-omie-dataset.json`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { generateTidsciDataset } from "./generate-dataset.js";
import { readTidsciArchive, countNotaFiscalSaidasBySchema } from "./archive-read.js";
import { createOpenAiCatalogParser } from "./openai-parser.js";
import { tidsciCatalogCachePath, tidsciDatasetPath } from "./paths.js";

function loadRootEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function parseArgs(argv: string[]) {
  let refreshCatalog = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--refresh-catalog") {
      refreshCatalog = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      i += 1;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--limit expects a non-negative number, got ${raw ?? "(missing)"}`);
      }
      limit = Math.floor(n);
      continue;
    }
    if (arg?.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--limit expects a non-negative number, got ${arg}`);
      }
      limit = Math.floor(n);
    }
  }
  return { refreshCatalog, limit };
}

/**
 * Runs one generate: archive SQL → catalog cache → dataset JSON.
 *
 * @param argv - CLI args (`--refresh-catalog`, `--limit N`).
 * @param env - Environment map.
 * @returns Mapped client/OS counts plus kind-change report.
 * @throws When `TID_ARCHIVE_DATABASE_URL` is unset or the archive query fails.
 */
export async function runTidsciGenerate(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
) {
  const { refreshCatalog, limit } = parseArgs(argv);
  const url = env.TID_ARCHIVE_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("TID_ARCHIVE_DATABASE_URL is not set");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const archive = await readTidsciArchive(client);
    const nfCounts = await countNotaFiscalSaidasBySchema(client);
    const parseMaterial = env.OPENAI_API_KEY?.trim()
      ? createOpenAiCatalogParser(env)
      : undefined;
    const result = await generateTidsciDataset({
      archive,
      cachePath: tidsciCatalogCachePath(env),
      outputPath: tidsciDatasetPath(env),
      parseMaterial,
      refreshCatalog,
      limit,
      openaiApiKey: env.OPENAI_API_KEY,
    });
    return {
      clientCount: result.clients.length,
      serviceOrderCount: result.serviceOrders.length,
      productCount: result.products.length,
      skippedUncached: result.skippedUncached,
      parsed: result.parsed,
      kindChanges: result.kindChanges,
      nfCounts,
    };
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1]?.replaceAll("\\", "/").endsWith("/generate.ts");
if (invoked) {
  loadRootEnv();
  runTidsciGenerate()
    .then((summary) => {
      console.log(
        JSON.stringify(
          {
            clients: summary.clientCount,
            serviceOrders: summary.serviceOrderCount,
            products: summary.productCount,
            parsed: summary.parsed,
            skippedUncached: summary.skippedUncached,
            notaFiscalSaidas: summary.nfCounts,
            kindChanges: summary.kindChanges,
          },
          null,
          2,
        ),
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
