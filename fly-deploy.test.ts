/**
 * Test design (testing-strategy)
 *
 * Setup: `planDeploy` is pure — target name, environment map and repository
 *   facts all arrive as arguments. No git, no flyctl, no network.
 *
 * Oracle: deploy — "Deploy command carries every build input the published SPA
 *   depends on" (refuse a missing input, refuse a commit that is not on
 *   origin/main, refuse a dirty tree, each naming what is wrong, and never
 *   print a secret value) and "Worker runs always-on as exactly one instance"
 *   (the worker deploy is followed by a scale to one).
 *
 * Why the argument list is asserted and not just the refusals: the bug this
 *   wrapper exists to prevent is a *silently incomplete* command — the README's
 *   `fly deploy` omits the MVP login pair and still succeeds, publishing a link
 *   that loads and cannot sign in. A test that only checked refusals would pass
 *   on a wrapper that forgot to forward the very inputs it validated.
 *
 * Axes
 *   A1 target — api / api:antigravity / worker / unknown
 *   A2 tree — clean / dirty
 *   A3 ancestry — HEAD on origin/main / not on it
 *   A4 api build inputs — all present / one missing / present but whitespace
 *
 * Outputs: O1 ready with commands; O2 refused with a naming message
 *
 * Sampled-cell
 *   api, clean, merged, complete      | A1 A2 A3 A4 | O1 | drop a build arg
 *   api:antigravity                   | A1          | O1 | reuse the cursor variant or app name
 *   worker                            | A1          | O1 | skip the scale-to-one
 *   unknown target                    | A1          | O2 | run something anyway
 *   dirty tree                        | A2          | O2 | publish an uncommitted tree
 *   not on origin/main                | A3          | O2 | publish an unmerged commit
 *   missing VITE_MVP_LOGIN_PASSWORD   | A4          | O2 | publish a link that cannot log in
 *   whitespace-only input             | A4 BVA      | O2 | treat "  " as supplied
 *   secret masking                    | A4          | O1 | echo a password to the terminal
 *
 * Decision / branch map: dirtyPaths.length > 0 T dirty, F clean;
 *   !headOnOriginMain T unmerged, F merged; missing.length > 0 T absent and
 *   whitespace, F all four present; kind === "api" T both api targets, F worker.
 *
 * Out of scope: whether flyctl succeeds (task 7.3–7.5 verify against the
 *   published origins); the health payload (apps/api/test/health.test.ts).
 */
import { describe, expect, it } from "vitest";
import { API_BUILD_INPUTS, TARGETS, planDeploy } from "./fly-deploy.mjs";

const HEAD = "a7cdf67131d82359078aeb2d033b1177cc71be71";

const CLEAN = { dirtyPaths: [], head: HEAD, headOnOriginMain: true };

const FULL_ENV = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key-value",
  VITE_MVP_LOGIN_EMAIL: "demo@example.com",
  VITE_MVP_LOGIN_PASSWORD: "demo-password",
};

/** One `[executable, args]` pair as the planner returns it. */
type Command = [string, string[]];

/**
 * Narrows a plan the test expects to be runnable.
 *
 * The planner returns a refusal or a plan, so every field is optional on the
 * union; failing here (rather than on a later `undefined`) keeps a broken
 * expectation readable.
 */
function ready(plan: { kind: string; app?: string; commands?: unknown; display?: unknown }) {
  expect(plan.kind).toBe("ready");
  return {
    app: plan.app,
    commands: plan.commands as Command[],
    display: plan.display as Command[],
  };
}

/** Flattens `["--build-arg", "NAME=value", ...]` into a `NAME -> value` map. */
function buildArgsOf(command: Command): Record<string, string> {
  const [, args] = command;
  const entries: [string, string][] = [];
  args.forEach((arg, index) => {
    if (args[index - 1] !== "--build-arg") return;
    const separator = arg.indexOf("=");
    entries.push([arg.slice(0, separator), arg.slice(separator + 1)]);
  });
  return Object.fromEntries(entries);
}

describe("planDeploy — a complete api deploy", () => {
  it("forwards the commit, the variant and every SPA build input", () => {
    const plan = ready(planDeploy({ target: "api", env: FULL_ENV, repo: CLEAN }));

    expect(plan.app).toBe("select-lub-crm-api");
    const args = buildArgsOf(plan.commands[0]);
    expect(args["GIT_COMMIT"]).toBe(HEAD);
    expect(args["VITE_UI_VARIANT"]).toBe("cursor");
    for (const name of API_BUILD_INPUTS) {
      expect(args[name]).toBe(FULL_ENV[name as keyof typeof FULL_ENV]);
    }
    expect(plan.commands[0][1]).toContain(TARGETS.api.config);
    expect(plan.commands[0][1]).toEqual(expect.arrayContaining(["--app", "select-lub-crm-api"]));
  });

  it("builds the antigravity origin from the same image with the other variant", () => {
    const plan = ready(planDeploy({ target: "api:antigravity", env: FULL_ENV, repo: CLEAN }));

    expect(plan.app).toBe("select-lub-compare-antigravity");
    expect(buildArgsOf(plan.commands[0])["VITE_UI_VARIANT"]).toBe("antigravity");
    // Same config file as cursor; the app name alone selects the origin.
    expect(plan.commands[0][1]).toContain("apps/api/fly.toml");
    expect(plan.commands[0][1]).toEqual(expect.arrayContaining(["--app", "select-lub-compare-antigravity"]));
  });

  it("masks secret values in the printable form while keeping them in the command", () => {
    const plan = ready(planDeploy({ target: "api", env: FULL_ENV, repo: CLEAN }));

    const printed = plan.display.map(([executable, args]) => `${executable} ${args.join(" ")}`).join("\n");
    expect(printed).not.toContain(FULL_ENV.VITE_MVP_LOGIN_PASSWORD);
    expect(printed).not.toContain(FULL_ENV.VITE_SUPABASE_ANON_KEY);
    expect(printed).toContain("VITE_MVP_LOGIN_PASSWORD=***");
    expect(buildArgsOf(plan.commands[0])["VITE_MVP_LOGIN_PASSWORD"]).toBe(FULL_ENV.VITE_MVP_LOGIN_PASSWORD);
  });
});

describe("planDeploy — the worker", () => {
  it("needs no SPA input and scales to exactly one machine after deploying", () => {
    const plan = ready(planDeploy({ target: "worker", env: {}, repo: CLEAN }));

    expect(buildArgsOf(plan.commands[0])["GIT_COMMIT"]).toBe(HEAD);
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[1][1]).toEqual(expect.arrayContaining(["scale", "count", "1"]));
  });

  it("does not scale the api", () => {
    const plan = ready(planDeploy({ target: "api", env: FULL_ENV, repo: CLEAN }));
    expect(plan.commands).toHaveLength(1);
  });
});

describe("planDeploy — refusals", () => {
  it("refuses an unknown target and lists the known ones", () => {
    const plan = planDeploy({ target: "web", env: FULL_ENV, repo: CLEAN });

    expect(plan.kind).toBe("refused");
    expect(plan.message).toContain("web");
    expect(plan.message).toContain("api:antigravity");
    expect(plan.commands).toBeUndefined();
  });

  it("refuses a dirty working tree, naming the uncommitted paths", () => {
    const plan = planDeploy({
      target: "api",
      env: FULL_ENV,
      repo: { ...CLEAN, dirtyPaths: ["apps/api/src/app.ts"] },
    });

    expect(plan.kind).toBe("refused");
    expect(plan.message).toContain("apps/api/src/app.ts");
  });

  it("refuses a commit that is not contained in origin/main, naming it", () => {
    const plan = planDeploy({
      target: "api",
      env: FULL_ENV,
      repo: { ...CLEAN, headOnOriginMain: false },
    });

    expect(plan.kind).toBe("refused");
    expect(plan.message).toContain(HEAD);
    expect(plan.message).toContain("origin/main");
  });

  it.each(API_BUILD_INPUTS)("refuses an api deploy missing %s", (name) => {
    const env = { ...FULL_ENV, [name]: undefined };

    const plan = planDeploy({ target: "api", env, repo: CLEAN });

    expect(plan.kind).toBe("refused");
    expect(plan.message).toContain(name);
  });

  it("treats a whitespace-only build input as missing", () => {
    const plan = planDeploy({
      target: "api",
      env: { ...FULL_ENV, VITE_MVP_LOGIN_PASSWORD: "   " },
      repo: CLEAN,
    });

    expect(plan.kind).toBe("refused");
    expect(plan.message).toContain("VITE_MVP_LOGIN_PASSWORD");
  });

  it("names no secret value in a refusal", () => {
    const plan = planDeploy({
      target: "api",
      env: { ...FULL_ENV, VITE_SUPABASE_URL: "" },
      repo: CLEAN,
    });

    expect(plan.message).not.toContain(FULL_ENV.VITE_MVP_LOGIN_PASSWORD);
    expect(plan.message).not.toContain(FULL_ENV.VITE_SUPABASE_ANON_KEY);
  });
});
