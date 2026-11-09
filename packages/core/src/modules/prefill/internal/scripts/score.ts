/**
 * Offline POC fixture scorer for prefill extraction quality against labeled JSON files.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrefillFieldKey, PrefillFields } from "../../contracts/http.js";
import { pickV1Fields, postFilterFilled } from "../gate.js";
import { defaultGeneratePrefillFields } from "../extract.js";

const V1_KEYS: PrefillFieldKey[] = [
  "name",
  "taxId",
  "plate",
  "make",
  "model",
  "version",
  "year",
  "odometerKm",
];

type Counts = { match: number; wrong: number; invented: number; miss: number };

function emptyCounts(): Record<PrefillFieldKey, Counts> {
  return {
    name: { match: 0, wrong: 0, invented: 0, miss: 0 },
    taxId: { match: 0, wrong: 0, invented: 0, miss: 0 },
    plate: { match: 0, wrong: 0, invented: 0, miss: 0 },
    make: { match: 0, wrong: 0, invented: 0, miss: 0 },
    model: { match: 0, wrong: 0, invented: 0, miss: 0 },
    version: { match: 0, wrong: 0, invented: 0, miss: 0 },
    year: { match: 0, wrong: 0, invented: 0, miss: 0 },
    odometerKm: { match: 0, wrong: 0, invented: 0, miss: 0 },
  };
}

function emptyBoolCounts(): Counts {
  return { match: 0, wrong: 0, invented: 0, miss: 0 };
}

function scoreField(extracted: PrefillFields, labels: PrefillFields, key: PrefillFieldKey): keyof Counts {
  const got = extracted[key];
  const want = labels[key];
  if (got === undefined && want === undefined) {
    return "match";
  }
  if (got === undefined && want !== undefined) {
    return "miss";
  }
  if (got !== undefined && want === undefined) {
    return "invented";
  }
  return got === want ? "match" : "wrong";
}

function scoreBool(got: unknown, want: unknown): keyof Counts {
  const extracted = typeof got === "boolean" ? got : undefined;
  const labeled = typeof want === "boolean" ? want : undefined;
  if (extracted === undefined && labeled === undefined) {
    return "match";
  }
  if (extracted === undefined && labeled !== undefined) {
    return "miss";
  }
  if (extracted !== undefined && labeled === undefined) {
    return "invented";
  }
  return extracted === labeled ? "match" : "wrong";
}

/**
 * Scores every JSON fixture in a directory against labeled v1 field expectations.
 *
 * @param dir - Folder of `.json` POC fixtures (`stored` / `pending` / `labels` / `messages`).
 * @param generate - Field extractor; defaults to {@link defaultGeneratePrefillFields} (needs OpenAI).
 * @returns Counts per v1 key and `shouldReply` (`match` / `wrong` / `invented` / `miss`) plus how many fixtures ran.
 */
export async function scorePocFolder(dir: string, generate = defaultGeneratePrefillFields) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const totals = emptyCounts();
  const shouldReply = emptyBoolCounts();
  let fixtures = 0;
  let inventedAnywhere = 0;
  for (const name of names) {
    const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      stored?: PrefillFields;
      pending?: PrefillFields;
      labels?: PrefillFields & { shouldReply?: boolean };
      messages?: { direction: string; textBody: string }[];
    };
    const labels = pickV1Fields((raw.labels ?? {}) as Record<string, unknown>);
    const stored = pickV1Fields((raw.stored ?? {}) as Record<string, unknown>);
    const pending = pickV1Fields((raw.pending ?? {}) as Record<string, unknown>);
    const lines = (raw.messages ?? [])
      .filter((item) => item.textBody)
      .slice(-10)
      .map((item) => `${item.direction}: ${item.textBody}`);
    const prompt = [
      `cadastro_armazenado: ${JSON.stringify(stored)}`,
      `sugestao_pendente: ${JSON.stringify(pending)}`,
      "mensagens:",
      ...lines,
    ].join("\n");
    const generated = await generate(prompt);
    const extracted = postFilterFilled(pickV1Fields(generated), stored);
    fixtures += 1;
    for (const key of V1_KEYS) {
      const bucket = scoreField(extracted, labels, key);
      totals[key][bucket] += 1;
      if (bucket === "invented") {
        inventedAnywhere += 1;
      }
    }
    const replyBucket = scoreBool(generated.shouldReply, raw.labels?.shouldReply);
    shouldReply[replyBucket] += 1;
    if (replyBucket === "invented") {
      inventedAnywhere += 1;
    }
  }
  return { fixtures, totals, inventedAnywhere, shouldReply };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pocDir = join(here, "fixtures", "poc");
  if (!process.env.OPENAI_API_KEY) {
    console.log("prefill:score skipped (OPENAI_API_KEY unset)");
    return;
  }
  let names: string[];
  try {
    names = (await readdir(pocDir)).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    console.log("prefill:score skipped (no poc json files)");
    return;
  }
  const result = await scorePocFolder(pocDir);
  console.log(
    JSON.stringify(
      {
        model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        fixtures: result.fixtures,
        totals: result.totals,
        shouldReply: result.shouldReply,
        inventedAnywhere: result.inventedAnywhere,
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void main();
}
