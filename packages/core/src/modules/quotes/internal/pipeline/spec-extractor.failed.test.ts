/**
 * Test design (testing-strategy) — the extractor's and escalation's failures
 *
 * SUT: createModelOilSpecExtractor and createEscalationExtractor, through the real AI SDK over a
 *   fake streamed Responses transport on fake timers (no socket, no key).
 *
 * Oracle:
 *   - review of #176 (2026-09-25) — a transient failure must never be saved as a miss, so the
 *     extractor answers {@link EXTRACTION_FAILED} when it could not read the passage (no key, a
 *     timeout, a reply it could not parse twice) and `null` only when it read it and the passage
 *     stated nothing;
 *   - background-oil-research D2 / `research-model-calls` "A call that reasons silently is not
 *     cut off": an extraction that reasons steadily for 90 s and then answers is used; one that
 *     reaches its ceiling is EXTRACTION_FAILED at once, with no retry (task 1.4);
 *   - D10 / task 1.4: escalation tells a failure (an error or a timeout: ESCALATION_FAILED) from a
 *     decline (`null`, the model saying the passages cannot be reconciled, or no key).
 *   - D5 / task 1.8: the prompt carries both halves of the column-table note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerScript, createdEvent, fakeTransport, reasoningEvents, reasoningStep, responsesStream, type ResponsesStep } from "../model-calls/fake-openai.js";

const { COLUMN_TABLE_NOTE, createEscalationExtractor, createModelOilSpecExtractor, OIL_SPEC_SYSTEM_PROMPT } = await import("./spec-extractor.js");
const { ESCALATION_FAILED, EXTRACTION_FAILED } = await import("./oil-spec.js");

const identity = { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" };
const source = {
  publisher: "servicos.fiat.com.br",
  document: "Manuais",
  page: "Manuais",
  content: { kind: "text" as const, text: "Baixe o manual do seu Fiat Argo." },
};
const EXTRACTION = '{"viscosityGrades":["5W-30"],"classification":"","fillLiters":3.5,"fillKind":"em_servico","engineCoverage":"one","enginesNamed":[]}';
const KEY = "test-key-not-real";

/** Reasoning every 5 s for `forMs`, then the answer. */
function reasoningFor(forMs: number, answer: string): ResponsesStep[] {
  const opening = reasoningEvents().slice(0, 2).map((event) => ({ event }));
  const steps: ResponsesStep[] = Array.from({ length: forMs / 5_000 }, () => reasoningStep(5_000));
  // created, the reasoning item opening, then a summary delta every 5 s, then the message and the end.
  return [{ event: createdEvent() }, ...opening, ...steps, ...answerScript(answer).slice(4)];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createModelOilSpecExtractor", () => {
  it("fails, rather than reporting silence, when it has no key", async () => {
    const transport = fakeTransport(() => responsesStream([]));

    expect(await createModelOilSpecExtractor({ transport: transport.fetch })(source, identity)).toBe(EXTRACTION_FAILED);
    expect(transport.requests).toHaveLength(0);
  });

  it("uses an extraction that reasons steadily for 90 s and then answers", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream(reasoningFor(90_000, EXTRACTION)));

    const pending = createModelOilSpecExtractor({ transport: transport.fetch })(source, identity);
    await vi.advanceTimersByTimeAsync(95_000);

    expect(await pending).toMatchObject({ viscosityGrades: ["5W-30"], fillLiters: 3.5 });
  });

  it("fails at once, with no retry, when the call reaches its ceiling", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream([{ afterMs: 1_000, event: createdEvent() }]));

    const pending = createModelOilSpecExtractor({ transport: transport.fetch })(source, identity);
    await vi.advanceTimersByTimeAsync(250_000);

    expect(await pending).toBe(EXTRACTION_FAILED);
    expect(transport.requests).toHaveLength(1);
  });

  it("fails when the reply cannot be parsed twice", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream(answerScript("desculpe, não consigo")));

    const pending = createModelOilSpecExtractor({ transport: transport.fetch })(source, identity);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe(EXTRACTION_FAILED);
    expect(transport.requests).toHaveLength(2);
  });

  it("answers null for an empty passage, which is read and silent", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream([]));

    expect(await createModelOilSpecExtractor({ transport: transport.fetch })({ ...source, content: { kind: "text", text: "  " } }, identity)).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });

  it("carries both halves of the column-table note in its prompt", () => {
    expect(OIL_SPEC_SYSTEM_PROMPT).toContain(COLUMN_TABLE_NOTE);
    expect(COLUMN_TABLE_NOTE).toContain(
      'Leia a coluna do motor do veículo do orçamento; se a identidade do veículo aponta uma única coluna, engineCoverage é "one"',
    );
    expect(COLUMN_TABLE_NOTE).toContain('se aponta mais de uma coluna, engineCoverage é "several".');
  });
});

describe("createEscalationExtractor: a failure is not a decline", () => {
  const input = {
    identity,
    conflicts: [],
    sources: [source],
  };

  it("declines with null when the model says the passages cannot be reconciled", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() =>
      responsesStream(answerScript('{"viscosityGrades":[],"classification":"","fillLiters":null,"fillKind":null}')),
    );

    const pending = createEscalationExtractor({ transport: transport.fetch })(input);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBeNull();
  });

  it("declines with null when no key is set", async () => {
    const transport = fakeTransport(() => responsesStream([]));

    expect(await createEscalationExtractor({ transport: transport.fetch })(input)).toBeNull();
    expect(transport.requests).toHaveLength(0);
  });

  it("fails with ESCALATION_FAILED on a timeout", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream([{ afterMs: 1_000, event: createdEvent() }]));

    const pending = createEscalationExtractor({ transport: transport.fetch })(input);
    await vi.advanceTimersByTimeAsync(250_000);

    expect(await pending).toBe(ESCALATION_FAILED);
  });

  it("fails with ESCALATION_FAILED on a provider error", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => new Response('{"error":{"message":"bad"}}', { status: 400 }));

    const pending = createEscalationExtractor({ transport: transport.fetch })(input);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe(ESCALATION_FAILED);
  });

  it("uses a settled answer", async () => {
    process.env.OPENAI_API_KEY = KEY;
    const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));

    const pending = createEscalationExtractor({ transport: transport.fetch })(input);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toMatchObject({ viscosityGrades: ["5W-30"] });
  });

  it("calls the escalation model at the escalation effort, not the research ones", async () => {
    process.env.OPENAI_API_KEY = KEY;
    process.env.ESCALATION_EFFORT = "high";
    try {
      const transport = fakeTransport(() => responsesStream(answerScript(EXTRACTION)));
      const pending = createEscalationExtractor({ transport: transport.fetch })(input);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(transport.requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "high" } });
    } finally {
      delete process.env.ESCALATION_EFFORT;
    }
  });
});
