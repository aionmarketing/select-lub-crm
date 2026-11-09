/**
 * Test design (testing-strategy)
 *
 * SUT: createTecfilOptionPicker (apps/api/src/oil-quote/tecfil-option-picker.ts),
 * with `generateObject` from the `ai` SDK mocked at the module boundary so no
 * OpenAI request is ever opened.
 *
 * Oracle: design D4 — the picker may only return a label Tecfil itself offered;
 * `none`, a reply outside the list, and any thrown error all count as no pick;
 * with no `OPENAI_API_KEY` it returns null WITHOUT calling the model; and the
 * model id comes from TECFIL_PICKER_MODEL, else OPENAI_MODEL, else the Motul
 * agent default.
 *
 * Axes
 *   A1 OPENAI_API_KEY — set vs absent (a gate, so no BVA)
 *   A2 model reply — a listed option / "none" / a string not in the list
 *   A3 the call itself — resolves vs throws
 *   A4 model id env — TECFIL_PICKER_MODEL set / only OPENAI_MODEL set / neither
 *
 * Outputs: O1 the chosen label verbatim; O2 null; O3 model-call count 0;
 *          O4 the model id passed to the provider
 *
 * Sampled cells (one row per `it`)
 *   key set, reply "207 SW"    | A1 set, A2 listed  | O1 | fails if a valid pick is dropped
 *   key set, reply "none"      | A2 none            | O2 | fails if "none" leaks out as a name
 *   key set, reply "208"       | A2 out-of-list     | O2 | fails if the reply is trusted unchecked
 *   key set, call throws       | A3 throws          | O2 | fails if the error escapes to the resolver
 *   no key                     | A1 absent          | O2 + O3 | fails if the SDK is called without a key
 *   empty option list          | A2 n/a, list empty | O2 + O3 | fails if an empty z.enum is built
 *   three env combinations     | A4                 | O4 | fails if the precedence order changes
 *
 * Decision map
 *   `!OPENAI_API_KEY || options.length === 0` true: no-key + empty-list tests;
 *                                             false: every other test
 *   `typeof choice !== "string" || !options.includes(choice)`
 *                                             true: "none" + out-of-list tests;
 *                                             false: the successful pick test
 *   catch                                     entered: throws test; skipped: the others
 *   `TECFIL_PICKER_MODEL ?? OPENAI_MODEL ?? default` all three arms: A4 table
 *
 * Out of scope: the picker timeout actually firing (a timer race with no observable
 * behavior beyond the catch already covered) and prompt wording (buildTecfilPickerPrompt
 * is asserted only for the fields it must carry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObject = vi.hoisted(() => vi.fn());
const modelIds = vi.hoisted(() => [] as string[]);

vi.mock("ai", () => ({ generateObject }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => (id: string) => {
    modelIds.push(id);
    return { id };
  },
}));

const { buildTecfilPickerPrompt, createTecfilOptionPicker, TECFIL_PICKER_DEFAULT_MODEL, tecfilPickerTimeoutMs } =
  await import("../catalog/tecfil-option-picker.js");
const { createUsageMeter } = await import("../model-calls/meter.js");

const identity = { make: "PEUGEOT", year: "2011", model: "207 Passion SW", version: "1.4i 8V" };
const options = ["207", "207 SW", "207 PASSION"];

beforeEach(() => {
  generateObject.mockReset();
  modelIds.length = 0;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_MODEL;
  delete process.env.TECFIL_PICKER_MODEL;
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.TECFIL_PICKER_MODEL;
});

describe("createTecfilOptionPicker", () => {
  it("returns the option the model chose", async () => {
    generateObject.mockResolvedValue({ object: { choice: "207 SW" } });

    const picked = await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(picked).toBe("207 SW");
  });

  it("returns null when the model answers none", async () => {
    generateObject.mockResolvedValue({ object: { choice: "none" } });

    const picked = await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(picked).toBeNull();
  });

  it("returns null when the model answers something outside the list", async () => {
    generateObject.mockResolvedValue({ object: { choice: "208" } });

    const picked = await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(picked).toBeNull();
  });

  it("returns null when the model call throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    generateObject.mockRejectedValue(new Error("boom"));

    const picked = await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(picked).toBeNull();
  });

  it("does not call the model when OPENAI_API_KEY is absent", async () => {
    delete process.env.OPENAI_API_KEY;

    const picked = await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(picked).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("does not call the model when Tecfil offered no options", async () => {
    const picked = await createTecfilOptionPicker()("engine", "1.4i 8V", identity, []);

    expect(picked).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  // background-oil-research D3 (task 1.6): the picker reports each call to the run's meter,
  // apart from the capped spend.
  it("reports its call, with its usage, to the meter as a picker call", async () => {
    generateObject.mockResolvedValue({
      object: { choice: "207 SW" },
      usage: { inputTokens: 300, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } },
    });
    const meter = createUsageMeter();

    await createTecfilOptionPicker({ meter })("vehicle", "207 Passion SW", identity, options);

    expect(meter.snapshot()).toMatchObject({ costUsd: 0, modelCalls: 0, picker: { calls: 1, usage: { input: 300, output: 20 } } });
  });

  it.each([
    { env: { TECFIL_PICKER_MODEL: "gpt-mini", OPENAI_MODEL: "gpt-big" }, expected: "gpt-mini" },
    { env: { OPENAI_MODEL: "gpt-big" }, expected: "gpt-big" },
    { env: {}, expected: TECFIL_PICKER_DEFAULT_MODEL },
  ])("uses the model $expected", async ({ env, expected }) => {
    Object.assign(process.env, env);
    generateObject.mockResolvedValue({ object: { choice: "207 SW" } });

    await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

    expect(modelIds).toEqual([expected]);
  });

  // background-oil-research D2, D12 (task 4.7): no quote waits on the picker any more, so its
  // bound is a setting, 60 s by default, read at each pick.
  it.each([
    { raw: undefined, expected: 60_000 },
    { raw: "90000", expected: 90_000 },
    { raw: "0", expected: 60_000 },
    { raw: "ten", expected: 60_000 },
  ])("bounds a pick by TECFIL_PICKER_TIMEOUT_MS=$raw at $expected ms", async ({ raw, expected }) => {
    if (raw === undefined) delete process.env.TECFIL_PICKER_TIMEOUT_MS;
    else process.env.TECFIL_PICKER_TIMEOUT_MS = raw;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    generateObject.mockResolvedValue({ object: { choice: "207 SW" } });
    try {
      await createTecfilOptionPicker()("vehicle", "207 Passion SW", identity, options);

      expect(tecfilPickerTimeoutMs()).toBe(expected);
      expect(timeout).toHaveBeenCalledWith(expected);
    } finally {
      timeout.mockRestore();
      delete process.env.TECFIL_PICKER_TIMEOUT_MS;
    }
  });
});

describe("buildTecfilPickerPrompt", () => {
  it("names the field, the CRM value, the full identity, and every option", () => {
    const prompt = buildTecfilPickerPrompt("engine", "1.4i 8V", identity, options);

    expect(prompt).toContain("campo: motor");
    expect(prompt).toContain("valor_no_crm: 1.4i 8V");
    expect(prompt).toContain('"model":"207 Passion SW"');
    for (const option of options) {
      expect(prompt).toContain(`- ${option}`);
    }
  });
});
