/**
 * Test design (testing-strategy): the OpenAI research model resolver and effort (switch-oil-research-to-openai tasks 1.1, 1.2)
 *
 * SUT: researchModel, openaiResearchTarget, researchModelLogLine, openaiEffortFor,
 *   openaiReadOptions, configuredResearchModelKey. Pure functions over the environment.
 *
 * Oracle: `research-model-calls` delta. "Every research model call goes to the one configured
 *   OpenAI model": `gpt-6.1-sol` by default, set by one variable, escalation overridable. "Every
 *   research call carries the configured reasoning effort": `medium` by default; the accepted values
 *   are `low|medium|high|xhigh|max`; a refused value falls back to the model's default, reported
 *   once; a model with no entry gets none. design.md D2 and D7 for the stored research model key.
 *
 * Cells
 *   defaults            | nothing set                          | gpt-6.1-sol at medium, escalation the same
 *   override            | OIL_RESEARCH_MODEL / _EFFORT high    | the setting
 *   escalation override | ESCALATION_MODEL / _EFFORT           | escalation apart, reads unchanged
 *   refused value       | effort `minimal`                     | medium, one warning even when asked twice
 *   no entry            | another OpenAI model                 | effort null, one warning
 *   no key              | OPENAI_API_KEY unset                 | target null
 *   options             | effort medium / null                 | reasoningEffort only when sent; summary auto; store false
 *   run key             | defaults; effort; no effort; legacy | openai:gpt-6.1-sol:medium, :low, :none; the glm: key kept
 *   start-up report     | defaults; high effort               | the model line; plus one unmeasured-limits line
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiEffortFor, resetEffortReportsForTests } from "./effort.js";
import {
  configuredResearchModelKey,
  LEGACY_RESEARCH_MODEL_KEY,
  openaiReadOptions,
  openaiResearchTarget,
  researchModel,
  reportResearchModel,
  researchModelLogLine,
} from "./research-model.js";

const VARS = ["OIL_RESEARCH_MODEL", "OIL_RESEARCH_REASONING_EFFORT", "ESCALATION_MODEL", "ESCALATION_EFFORT", "OPENAI_API_KEY"];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const name of VARS) delete process.env[name];
  resetEffortReportsForTests();
  vi.restoreAllMocks();
});

describe("researchModel", () => {
  it("defaults to gpt-6.1-sol at medium, escalation included", () => {
    expect(researchModel()).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      effort: "medium",
      escalationModel: "gpt-6.1-sol",
      escalationEffort: "medium",
      keyName: "OPENAI_API_KEY",
    });
    expect(JSON.parse(researchModelLogLine())).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("reads the model and the effort from their settings", () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "HIGH ";
    expect(researchModel()).toMatchObject({ model: "gpt-6.1-sol", effort: "high", escalationEffort: "high" });
  });

  it("lets escalation name its own model and effort without moving the reads", () => {
    process.env.ESCALATION_MODEL = "gpt-6.1-sol";
    process.env.ESCALATION_EFFORT = "xhigh";
    const config = researchModel();
    expect(config).toMatchObject({ model: "gpt-6.1-sol", effort: "medium", escalationModel: "gpt-6.1-sol", escalationEffort: "xhigh" });
  });

  it("replaces a value the model refuses by its default and reports it once", () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "minimal";
    expect(researchModel().effort).toBe("medium");
    expect(researchModel().effort).toBe("medium");
    const reports = warn.mock.calls.filter(([message]) => message === "openai-effort");
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]))).toMatchObject({ outcome: "not_accepted", model: "gpt-6.1-sol", value: "minimal", sent: "medium" });
  });

  it("sends no effort to a model with no entry, and reports it once", () => {
    process.env.OIL_RESEARCH_MODEL = "gpt-9-unknown";
    expect(researchModel().effort).toBeNull();
    expect(openaiEffortFor("gpt-9-unknown")).toBeNull();
    expect(warn.mock.calls.filter(([message]) => message === "openai-effort")).toHaveLength(1);
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("accepts %s on gpt-6.1-sol", (effort) => {
    expect(openaiEffortFor("gpt-6.1-sol", effort)).toBe(effort);
  });
});

describe("openaiResearchTarget", () => {
  it("is null without OPENAI_API_KEY", () => {
    expect(openaiResearchTarget()).toBeNull();
  });

  it("names the read model, or the escalation model", () => {
    process.env.OPENAI_API_KEY = "placeholder-not-a-key";
    process.env.ESCALATION_EFFORT = "high";
    expect(openaiResearchTarget()).toEqual({ provider: "openai", apiKey: "placeholder-not-a-key", model: "gpt-6.1-sol", effort: "medium" });
    expect(openaiResearchTarget("escalation")).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });
});

describe("openaiReadOptions", () => {
  it("sends the effort, asks for reasoning summaries and keeps nothing at the provider", () => {
    expect(openaiReadOptions("medium")).toEqual({ openai: { reasoningEffort: "medium", reasoningSummary: "auto", store: false } });
    expect(openaiReadOptions(null)).toEqual({ openai: { reasoningSummary: "auto", store: false } });
  });
});

describe("configuredResearchModelKey", () => {
  it("names gpt-6.1-sol at medium by default", () => {
    expect(configuredResearchModelKey()).toBe("openai:gpt-6.1-sol:medium");
  });

  it("follows the effort setting", () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "low";
    expect(configuredResearchModelKey()).toBe("openai:gpt-6.1-sol:low");
  });

  it("records none for a model sent no effort", () => {
    process.env.OIL_RESEARCH_MODEL = "gpt-9-unknown";
    expect(configuredResearchModelKey()).toBe("openai:gpt-9-unknown:none");
  });

  it("keeps the legacy key of a run written before research models were recorded", () => {
    expect(LEGACY_RESEARCH_MODEL_KEY).toBe("glm:glm-5.3-flash:high");
  });
});

// Task 1.5 / PR B: a composition root calls this once at start-up. The worker does; see
// apps/worker/test for the call itself.
describe("reportResearchModel", () => {
  it("logs the research model and effort, and nothing else when the limits are measured", () => {
    const lines: [string, string][] = [];

    reportResearchModel((message, detail) => lines.push([message, detail]));

    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe("oil-research-model");
    expect(JSON.parse(lines[0]![1])).toEqual({ provider: "openai", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("also reports, once per pair, a configured model and effort with no measured limits", () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "high";
    process.env.ESCALATION_EFFORT = "high";
    const lines: [string, string][] = [];

    reportResearchModel((message, detail) => lines.push([message, detail]));

    expect(lines.map(([message]) => message)).toEqual(["oil-research-model", "openai-limits"]);
    expect(JSON.parse(lines[1]![1])).toMatchObject({ model: "gpt-6.1-sol", effort: "high", settings: ["OIL_RESEARCH_MODEL", "ESCALATION_MODEL"] });
  });
});
