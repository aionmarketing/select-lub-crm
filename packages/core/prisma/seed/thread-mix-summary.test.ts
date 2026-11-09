/**
 * Test design (testing-strategy)
 *
 * Setup: pure markdown builder plus a temp directory for the skip/write IO.
 *
 * Oracle: demo-seed — "The seed writes a thread-mix summary markdown": fake name
 * or pré-cadastro, one-line blurb, SEED count, archetypes, unfilled list; no
 * phone, chat key, or body. Skip when demo is off.
 *
 * Axes
 *   A1 enabled — true / false
 *   A2 unfilled — none / some
 *   A3 threads — none / one / several
 *
 * Decision map
 *   D1 enabled false → no file touch
 *   D2 digit run 8–15 → builder throws (defense in depth)
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildThreadMixMarkdown,
  writeThreadMixSummaryIfEnabled,
  type ThreadMixSummary,
} from "./thread-mix-summary.js";

const SAMPLE: ThreadMixSummary = {
  unfilled: [{ archetype: "familyCar", reason: "no unused conversation has a stored vehicle" }],
  threads: [
    {
      displayName: "Ana Souza",
      blurb: "Troca de óleo do veículo que está na ficha",
      seedCount: 8,
      archetypes: ["truePositive", "clean"],
    },
    {
      displayName: "pré-cadastro",
      blurb: "Pergunta de horário, sábado e onde fica a loja",
      seedCount: 3,
      archetypes: ["bareHours", "mistyped"],
    },
  ],
};

describe("buildThreadMixMarkdown", () => {
  it("lists every thread with name or pré-cadastro, blurb, count, and archetypes", () => {
    const markdown = buildThreadMixMarkdown(SAMPLE);

    expect(markdown).toContain("### Ana Souza");
    expect(markdown).toContain("### pré-cadastro");
    expect(markdown).toContain("Troca de óleo do veículo que está na ficha");
    expect(markdown).toContain("mensagens SEED: 8");
    expect(markdown).toContain("mensagens SEED: 3");
    expect(markdown).toContain("truePositive, clean");
    expect(markdown).toContain("bareHours, mistyped");
  });

  it("names unfilled archetypes in a leading section", () => {
    const markdown = buildThreadMixMarkdown(SAMPLE);

    expect(markdown).toContain("## Arquétipos sem conversa");
    expect(markdown).toContain("familyCar");
  });

  it("contains no phone, chat key, or message body", () => {
    const markdown = buildThreadMixMarkdown(SAMPLE);

    expect(markdown).not.toMatch(/\d{8,15}/);
    expect(markdown).not.toContain("@s.whatsapp.net");
    expect(markdown).not.toContain("Oi, vocês abrem");
  });

  it("refuses to build markdown that contains a phone-like digit run", () => {
    expect(() =>
      buildThreadMixMarkdown({
        unfilled: [],
        threads: [
          {
            displayName: "5519000000001",
            blurb: "recado",
            seedCount: 2,
            archetypes: ["bareHours"],
          },
        ],
      }),
    ).toThrow(/phone-like digit run/);
  });
});

describe("writeThreadMixSummaryIfEnabled", () => {
  it("does not create or overwrite the file when demo seed is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thread-mix-"));
    const filePath = join(dir, "thread-mix.md");

    const result = await writeThreadMixSummaryIfEnabled(false, SAMPLE, filePath);

    expect(result.wrote).toBe(false);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overwrites the file when demo seed ran", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thread-mix-"));
    const filePath = join(dir, "thread-mix.md");
    await writeFile(filePath, "stale\n", "utf8");

    const result = await writeThreadMixSummaryIfEnabled(true, SAMPLE, filePath);

    expect(result.wrote).toBe(true);
    const written = await readFile(filePath, "utf8");
    expect(written).toContain("Ana Souza");
    expect(written).not.toContain("stale");
  });
});
