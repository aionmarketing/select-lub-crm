/**
 * Test design (testing-strategy)
 *
 * Setup: scorePocFolder against a temp dir of fixture JSON. generate is
 * injected; OpenAI is never called.
 *
 * Oracle: assistive-cadastro-prefill quality buckets — match / wrong /
 * invented / miss per v1 key.
 *
 * Axes
 *   A1 extracted vs labels: equal | unequal | extracted-only | labels-only | both absent
 *   A2 fixture count: 0 json files vs ≥1
 *
 *   A3 shouldReply extracted vs labels: equal | unequal | extracted-only | labels-only | both absent
 *
 * Outputs: O-match, O-wrong, O-invented, O-miss, O-fixtures 0
 *
 * Sampled-cell
 *   plate equal                         | match
 *   name unequal                        | wrong
 *   make extracted, labels omit         | invented
 *   taxId labels set, extracted omit    | miss
 *   model both omit                     | match
 *   empty folder                        | fixtures 0
 *   shouldReply true/true               | match
 *   shouldReply true vs false           | wrong
 *   shouldReply extracted-only          | invented
 *   shouldReply labels-only             | miss
 *
 * Decision map (score.ts scoreField + scoreBool + scorePocFolder)
 *   D1 got undefined && want undefined  T: model in scored fixture; F: other buckets
 *   D2 got undefined && want set        T: taxId miss
 *   D3 got set && want undefined        T: make invented
 *   D4 got === want                     T: plate; F: name wrong
 *   D5 names.endsWith .json             T: scored file; F: empty dir
 *   D6 inventedAnywhere +=              T: make invented; F: empty-json / empty-folder
 *   D7 labels/stored/pending/messages ?? T: first fixture present; F: empty json `{}`
 *   D8 shouldReply typeof boolean       T: reply its; F: omitted both = match (empty json)
 *
 * Out of scope: defaultGeneratePrefillFields / live OpenAI (extract.test.ts
 * covers missing-key throw; CI must not call OpenAI). main() CLI skip when
 * OPENAI_API_KEY unset — process entry, not imported as SUT under Vitest
 * (lines 87–122).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scorePocFolder } from "./score.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scorePocFolder", () => {
  it("buckets match, wrong, invented, and miss from one fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prefill-score-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "one.json"),
      JSON.stringify({
        labels: { plate: "ABC1D23", name: "Ana", taxId: "1" },
        stored: {},
        pending: {},
        messages: [
          { direction: "inbound", textBody: "" },
          { direction: "inbound", textBody: "placa ABC1D23" },
        ],
      }),
    );

    let prompt = "";
    const result = await scorePocFolder(dir, async (text) => {
      prompt = text;
      return {
        plate: "ABC1D23",
        name: "Bob",
        make: "VW",
      };
    });

    expect(prompt).toContain("placa ABC1D23");
    expect(prompt).not.toContain("inbound: \n");

    expect(result.fixtures).toBe(1);
    expect(result.totals.plate.match).toBe(1);
    expect(result.totals.name.wrong).toBe(1);
    expect(result.totals.make.invented).toBe(1);
    expect(result.totals.taxId.miss).toBe(1);
    expect(result.totals.model.match).toBe(1);
    expect(result.inventedAnywhere).toBe(1);
  });

  it("treats a fixture with omitted stored, pending, labels, and messages as all-match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prefill-score-empty-json-"));
    dirs.push(dir);
    await writeFile(join(dir, "empty.json"), "{}");

    const result = await scorePocFolder(dir, async () => ({}));

    expect(result.fixtures).toBe(1);
    expect(result.inventedAnywhere).toBe(0);
    expect(result.totals.plate.match).toBe(1);
  });

  it("returns zero fixtures when the folder has no json files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prefill-score-empty-"));
    dirs.push(dir);

    const result = await scorePocFolder(dir, async () => {
      throw new Error("generate must not run");
    });

    expect(result.fixtures).toBe(0);
    expect(result.inventedAnywhere).toBe(0);
  });

  it("buckets shouldReply match, wrong, invented, and miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prefill-score-reply-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "match.json"),
      JSON.stringify({ labels: { shouldReply: true }, messages: [{ direction: "inbound", textBody: "quanto custa?" }] }),
    );
    await writeFile(
      join(dir, "wrong.json"),
      JSON.stringify({ labels: { shouldReply: true }, messages: [{ direction: "inbound", textBody: "ok" }] }),
    );
    await writeFile(
      join(dir, "invented.json"),
      JSON.stringify({ labels: {}, messages: [{ direction: "inbound", textBody: "oi" }] }),
    );
    await writeFile(
      join(dir, "miss.json"),
      JSON.stringify({ labels: { shouldReply: false }, messages: [{ direction: "inbound", textBody: "obrigado" }] }),
    );

    const byName: Record<string, Record<string, unknown>> = {
      "quanto custa?": { shouldReply: true },
      ok: { shouldReply: false },
      oi: { shouldReply: true },
      obrigado: {},
    };
    const result = await scorePocFolder(dir, async (prompt) => {
      const line = prompt.split("\n").find((row) => row.startsWith("inbound: "));
      const body = line?.slice("inbound: ".length) ?? "";
      return byName[body] ?? {};
    });

    expect(result.shouldReply.match).toBe(1);
    expect(result.shouldReply.wrong).toBe(1);
    expect(result.shouldReply.invented).toBe(1);
    expect(result.shouldReply.miss).toBe(1);
    expect(result.inventedAnywhere).toBe(1);
  });
});
