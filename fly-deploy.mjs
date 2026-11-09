/**
 * Deploys one published app to Fly with every build input its image needs.
 *
 * Exists because the README's bare `fly deploy` command is incomplete in a way
 * that fails silently: it omits `VITE_MVP_LOGIN_EMAIL` / `VITE_MVP_LOGIN_PASSWORD`,
 * which the SPA bundle inlines for auto-login, so a deploy without them
 * publishes a link that loads and then refuses to sign anyone in. It also
 * cannot stamp the commit, which is what `/health` reports.
 *
 * Node rather than a shell script for the same reason `apps/e2e/run-live.mjs`
 * is: inline `VAR=1 cmd` and `$(git rev-parse HEAD)` are POSIX-only, and the
 * operator machine is Windows.
 *
 * Usage: `pnpm deploy:api` | `pnpm deploy:api:antigravity` | `pnpm deploy:worker`
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Published apps this wrapper knows how to deploy.
 *
 * Both api targets share `apps/api/fly.toml`; the app name is passed with
 * `--app`, which flyctl lets override the config's own `app =` line. One config
 * means a memory bump or a `min_machines_running` change reaches both origins,
 * where a second copy of the file would silently let them diverge.
 */
export const TARGETS = Object.freeze({
  api: {
    app: "select-lub-crm-api",
    config: "apps/api/fly.toml",
    kind: "api",
    variant: "cursor",
  },
  "api:antigravity": {
    app: "select-lub-compare-antigravity",
    config: "apps/api/fly.toml",
    kind: "api",
    variant: "antigravity",
  },
  worker: {
    app: "select-lub-crm-worker",
    config: "apps/worker/fly.toml",
    kind: "worker",
  },
});

/**
 * SPA build inputs Vite inlines into the bundle.
 *
 * All four are required for an api target: a missing Supabase pair renders a
 * Portuguese auth error, and a missing login pair renders the same error with
 * no way for a visitor to get past it (auth — "Login screen": the SPA has no
 * credential form by design).
 */
export const API_BUILD_INPUTS = Object.freeze([
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_MVP_LOGIN_EMAIL",
  "VITE_MVP_LOGIN_PASSWORD",
]);

/** Build inputs whose values must never be echoed. */
const SECRET_INPUTS = new Set(["VITE_SUPABASE_ANON_KEY", "VITE_MVP_LOGIN_EMAIL", "VITE_MVP_LOGIN_PASSWORD"]);

/**
 * Decides what to run, or why not to run anything.
 *
 * Pure: every fact about the repository arrives in `repo`, so the refusals can
 * be tested without a git checkout in any particular state.
 *
 * @param input - Target name, environment map, and resolved repository state.
 * @param input.target - Key of {@link TARGETS}.
 * @param input.env - Environment to read build inputs from.
 * @param input.repo - `dirtyPaths` from `git status --porcelain`, `head` SHA, and whether HEAD is contained in `origin/main`.
 * @returns `{ kind: "refused", message }` or `{ kind: "ready", commands, display }` where `display` is the same commands with secret values masked.
 */
export function planDeploy({ target, env, repo }) {
  const spec = TARGETS[target];
  if (!spec) {
    const known = Object.keys(TARGETS).join(", ");
    return { kind: "refused", message: `Unknown deploy target "${target}". Known targets: ${known}.` };
  }

  if (repo.dirtyPaths.length > 0) {
    const listed = repo.dirtyPaths.slice(0, 10).join(", ");
    return {
      kind: "refused",
      message:
        `Working tree is not clean, so the published image would not match any commit.\n` +
        `Uncommitted: ${listed}${repo.dirtyPaths.length > 10 ? ", ..." : ""}`,
    };
  }

  if (!repo.headOnOriginMain) {
    return {
      kind: "refused",
      message:
        `HEAD (${repo.head}) is not contained in origin/main.\n` +
        `deploy — "Production images are built from origin/main": merge the pull request first, then deploy that commit.`,
    };
  }

  const buildArgs = [`GIT_COMMIT=${repo.head}`];

  if (spec.kind === "api") {
    const missing = API_BUILD_INPUTS.filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
      return {
        kind: "refused",
        message:
          `Missing SPA build input(s): ${missing.join(", ")}.\n` +
          `These are inlined into the bundle at build time; deploying without them publishes a link that cannot sign in.`,
      };
    }
    buildArgs.push(`VITE_UI_VARIANT=${spec.variant}`);
    for (const name of API_BUILD_INPUTS) {
      buildArgs.push(`${name}=${env[name]}`);
    }
    // Same-origin API: the SPA calls /conversations on the host it loaded from.
    buildArgs.push("VITE_API_BASE=");
  }

  const deploy = [
    "flyctl",
    ["deploy", ".", "--app", spec.app, "--config", spec.config, ...buildArgs.flatMap((arg) => ["--build-arg", arg])],
  ];
  const commands = [deploy];

  if (spec.kind === "worker") {
    // deploy — "Worker runs always-on as exactly one instance": the outbox
    // claims rows without SKIP LOCKED, so a second machine double-sends.
    commands.push(["flyctl", ["scale", "count", "1", "--app", spec.app, "--yes"]]);
  }

  return { kind: "ready", app: spec.app, commands, display: commands.map(maskCommand) };
}

/**
 * Masks secret build-arg values so a command can be printed.
 *
 * @param command - `[executable, args]` pair.
 * @returns The same pair with secret `--build-arg NAME=value` values replaced by `***`.
 */
function maskCommand([executable, args]) {
  return [
    executable,
    args.map((arg) => {
      const separator = arg.indexOf("=");
      if (separator < 1) return arg;
      const name = arg.slice(0, separator);
      return SECRET_INPUTS.has(name) ? `${name}=***` : arg;
    }),
  ];
}

/**
 * Runs `git` and returns trimmed stdout.
 *
 * @param args - Arguments after `git`.
 * @returns Trimmed stdout, or `null` when the command exits non-zero.
 */
function git(args) {
  // No shell: git and flyctl are .exe on the operator machine, and a shell would
  // re-join these args into one cmd.exe line where a value containing a space or
  // `&` is split or executed (Node DEP0190).
  const result = spawnSync("git", args, { encoding: "utf8" });
  // trimEnd, not trim: `status --porcelain` lines start with a status column
  // that may be a space (` M path`), and a full trim would eat it on the first
  // line so the path came out as `ockerfile.api`.
  return result.status === 0 ? result.stdout.trimEnd() : null;
}

/**
 * Reads the repository facts {@link planDeploy} needs.
 *
 * @returns `{ dirtyPaths, head, headOnOriginMain }`.
 */
function readRepo() {
  const status = git(["status", "--porcelain"]) ?? "";
  const dirtyPaths = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const head = git(["rev-parse", "HEAD"]) ?? "unknown";
  // Fetch first: a stale remote ref would let an unmerged commit look merged.
  git(["fetch", "origin", "main"]);
  return { dirtyPaths, head, headOnOriginMain: git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]) !== null };
}

/** Entry point: plan, then run each command, exiting with the first failure's status. */
function main() {
  const target = process.argv[2];
  const envPath = resolve(import.meta.dirname, ".env");
  // Only as a fallback: CI and an operator shell may already export these.
  if (existsSync(envPath) && API_BUILD_INPUTS.some((name) => !process.env[name])) {
    process.loadEnvFile(envPath);
  }

  const plan = planDeploy({ target, env: process.env, repo: readRepo() });
  if (plan.kind === "refused") {
    console.error(plan.message);
    process.exit(1);
  }

  console.log(`Deploying ${plan.app}`);
  for (const [index, [executable, args]] of plan.commands.entries()) {
    const [, shown] = plan.display[index];
    console.log(`> ${executable} ${shown.join(" ")}`);
    const result = spawnSync(executable, args, {
      stdio: "inherit",
      cwd: import.meta.dirname,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

// Importable by the test without deploying anything.
if (process.argv[1] && process.argv[1].endsWith("fly-deploy.mjs")) {
  main();
}
