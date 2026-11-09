/**
 * Test design (testing-strategy)
 *
 * Setup: read README.md, main.tsx, AppProviders.tsx, then walk product
 * src (.ts/.tsx/.css/.html). Skip *.test.ts so this file can name the
 * Google Fonts hosts without failing itself.
 *
 * Spec rule (openspec/specs/design-system/spec.md + repo-foundation):
 *   Conversas is `/`, gallery is `/galeria`, spacing(0.5) is documented.
 *   Inter is bundled. ThemeProvider wraps the SPA. No Google Fonts CDN.
 *
 * Partitions (one numbered group = strings the spec treats the same):
 *
 *   P1 VALID   — README names Conversas at `/`, `/galeria`, spacing(0.5)
 *   P2 VALID   — main.tsx imports @fontsource/inter; AppProviders has
 *                ThemeProvider
 *   P3 INVALID — fonts.googleapis.com or fonts.gstatic.com in product src
 *   P4 VALID   — README names fetch-on-demand, no archive, base64 false, 16 MiB
 *   P5 VALID   — README names Motul demo as network-only and not in CI
 *   P6 VALID   — AGENTS.md names color.whatsapp, never #25D366 on success,
 *                half-steps, and does not set spacing: 4
 *   P7 VALID   — README + .env.example name SUPABASE_URL, publishable SPA
 *                key, API-only service-role, Auth on, Data API off,
 *                Evolution webhook secret
 *   P8 VALID   — README names attendant-a/b isolation emails, no passwords,
 *                and that a seed Auth-uuid mismatch 403s unit-scoped routes
 *   P9 INVALID — product src VITE_ + SERVICE_ROLE (service-role in SPA)
 *   P10 VALID  — README + .env.example name VITE_MVP_LOGIN_EMAIL /
 *                VITE_MVP_LOGIN_PASSWORD, auto-logs in / no login form,
 *                no password value next to attendant-a or on the password var
 *   P11 VALID  — README names Conversas search, Nova conversa,
 *                four-state channel, origem stays desconhecida until classification
 *   P12 VALID  — README Deployment names Fly.io gru, WhatsEvolution,
 *                PEND-CH-02/03 on #21, SKIP LOCKED / single worker, DIRECT_URL
 *   P13 VALID  — fly.toml literals: api autostop / worker always-on port 3001
 *
 * Output partitions:
 *   O1 — required substrings present (P1/P2/P4/P5/P6)
 *   O2 — Google Fonts host found (P3)
 *
 * Map from each `it` to a partition:
 *
 *   documents Conversas at /, gallery at /galeria, and the 4px spacing half-step
 *     P1 → README contains those three strings
 *
 *   documents fetch-on-demand media… — P4
 *   documents Motul demo as network-only and excluded from CI — P5
 *   documents WhatsApp as color.whatsapp and spacing half-steps — P6
 *   documents Supabase Auth env and Data API off — P7
 *   names two-unit isolation emails without passwords — P8
 *     also: seed Auth-uuid mismatch 403s unit-scoped routes (README + .env.example)
 *     also: seed Auth-uuid mismatch 403s unit-scoped routes (README + .env.example)
 *   documents SPA auto-login env names without a password value — P10
 *   documents Conversas search, Nova conversa, four-state, origem — P11
 *   does not expose service-role as a VITE_ value in product src — P9
 *   bundles Inter and wraps the SPA in ThemeProvider — P2
 *   does not load Inter from a Google Fonts URL — P3
 *
 * What would make a test fail:
 *   deleting the `/galeria` sentence from README
 *   a Google Fonts `<link>` in main.tsx
 *   removing `color.whatsapp` from AGENTS.md
 *
 * Production decisions: none. This suite reads docs and source strings.
 *
 * Out of scope: 320px wrapping (visual QA); swapping Inter for a
 * confirmed brand font; `openspec validate --specs` in CI (no pinned
 * OpenSpec CLI in package.json).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = import.meta.dirname;
const repoReadme = join(srcRoot, "../../../README.md");
const GOOGLE_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
      continue;
    }
    if (![".ts", ".tsx", ".css", ".html"].includes(extname(entry))) {
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      continue;
    }
    files.push(full);
  }
  return files;
}

describe("design-system and README docs", () => {
  it("documents Conversas at /, gallery at /galeria, and the 4px spacing half-step", () => {
    const readme = readFileSync(repoReadme, "utf8");
    expect(readme).toContain("Conversas at `/`");
    expect(readme).toContain("/galeria");
    expect(readme).toContain("spacing(0.5)");
  });

  it("documents Configurações, empty tag seed, CRM-internal tags, and template insert without send", () => {
    const readme = readFileSync(repoReadme, "utf8");
    expect(readme).toContain("/configuracoes");
    expect(readme).toContain("does **not** insert tags or templates");
    expect(readme).toContain("Tags are CRM-internal");
    expect(readme).toContain("does **not** send WhatsApp");
  });

  it("documents fetch-on-demand media and that the CRM does not archive attachments", () => {
    const readme = readFileSync(repoReadme, "utf8");
    expect(readme).toContain("fetch-on-demand");
    expect(readme).toContain("does not archive attachments");
    expect(readme).toContain('"base64": false');
    expect(readme).toContain("16 MiB");
  });

  it("documents Motul demo as network-only and excluded from CI", () => {
    const readme = readFileSync(repoReadme, "utf8");
    expect(readme).toContain("pnpm --filter @select-lub/core motul:demo");
    expect(readme).toContain("needs network");
    expect(readme).toContain("not in CI");
  });

  it("documents WhatsApp as color.whatsapp and spacing half-steps", () => {
    const agents = readFileSync(join(srcRoot, "../../../AGENTS.md"), "utf8");
    expect(agents).toContain("`color.whatsapp`");
    expect(agents).toContain("must never be `#25D366`");
    expect(agents).toContain("half-steps");
    expect(agents).toContain("Do not set `spacing: 4`");
  });

  it("documents Supabase Auth on, Data API off, publishable SPA key, API-only service-role, and Evolution webhook secret", () => {
    const readme = readFileSync(repoReadme, "utf8");
    const envExample = readFileSync(join(srcRoot, "../../../.env.example"), "utf8");
    expect(readme).toContain("SUPABASE_URL");
    expect(readme).toContain("publishable");
    expect(readme).toContain("VITE_SUPABASE_ANON_KEY");
    expect(readme).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(readme).toContain("Supabase Auth is on");
    expect(readme).toContain("Data API");
    expect(readme).toContain("stays off");
    expect(readme).toContain("EVOLUTION_WEBHOOK_SECRET");
    expect(readme).toContain("Evolution secret");
    expect(envExample).toContain("SUPABASE_URL");
    expect(envExample).toContain("VITE_SUPABASE_ANON_KEY");
    expect(envExample).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(envExample).toContain("Data API");
    expect(envExample).toContain("Never prefix with VITE_");
  });

  it("names the two-unit isolation users without passwords", () => {
    const readme = readFileSync(repoReadme, "utf8");
    const envExample = readFileSync(join(srcRoot, "../../../.env.example"), "utf8");
    expect(readme).toContain("attendant-a@selectlub.example");
    expect(readme).toContain("attendant-b@selectlub.example");
    expect(readme).toContain("Select Lub 2");
    expect(readme).toContain("passwords stay out of git");
    expect(readme).toContain("SEED_USER_A_ID");
    expect(readme).toContain("every unit-scoped route returns 403");
    expect(readme).toContain("SPA shell still renders");
    expect(envExample).toContain("SEED_USER_A_ID");
    expect(envExample).toContain("403s every unit-scoped route");
    expect(readme).not.toMatch(/attendant-a@selectlub\.example[^\n]*password\s*=/i);
    expect(readme).not.toMatch(/password\s*=[^\n]*attendant-a@selectlub\.example/i);
  });

  it("documents SPA auto-login env names without a password value", () => {
    const readme = readFileSync(repoReadme, "utf8");
    const envExample = readFileSync(join(srcRoot, "../../../.env.example"), "utf8");
    expect(readme).toContain("VITE_MVP_LOGIN_EMAIL");
    expect(readme).toContain("VITE_MVP_LOGIN_PASSWORD");
    expect(readme).toContain("auto-logs in");
    expect(readme).toContain("does not show a login form");
    expect(readme).toContain("passwords stay out of git");
    expect(readme).not.toMatch(/VITE_MVP_LOGIN_PASSWORD=\S+/);
    expect(envExample).toContain("VITE_MVP_LOGIN_EMAIL");
    expect(envExample).toContain("VITE_MVP_LOGIN_PASSWORD");
    expect(envExample).toContain("auto-logs in");
    expect(envExample).toContain("does not show a login form");
    expect(envExample).not.toMatch(/VITE_MVP_LOGIN_PASSWORD=\S+/);
    expect(envExample).not.toMatch(/attendant-a@selectlub\.example[^\n]*password\s*=/i);
    expect(envExample).not.toMatch(/password\s*=[^\n]*attendant-a@selectlub\.example/i);
  });

  it("documents Conversas search, Nova conversa, four-state channel, and origem until classification", () => {
    const readme = readFileSync(repoReadme, "utf8");
    expect(readme).toContain("inbox search matches contact name or phone");
    expect(readme).toContain("Nova conversa");
    expect(readme).toContain("four-state");
    expect(readme).toContain("origem stays desconhecida until classification");
  });

  it("documents Fly.io gru for web/api/worker, WhatsEvolution, and open PEND-CH-02/03 on #21", () => {
    const readme = readFileSync(repoReadme, "utf8");
    const envExample = readFileSync(join(srcRoot, "../../../.env.example"), "utf8");
    expect(readme).toContain("Fly.io");
    expect(readme).toContain("`gru`");
    expect(readme).toContain("WhatsEvolution");
    expect(readme).toContain("PEND-CH-02");
    expect(readme).toContain("PEND-CH-03");
    expect(readme).toContain("#21");
    expect(readme).toContain("SKIP LOCKED");
    expect(readme).toContain("auto_stop_machines = false");
    expect(readme).toContain("DIRECT_URL");
    expect(readme).toContain("never run on the Fly machines");
    expect(readme).toContain("min_machines_running = 1");
    expect(readme).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY=\S+/);
    expect(readme).not.toMatch(/FLY_API_TOKEN=\S+/);
    expect(envExample).toContain("DIRECT_URL");
    expect(envExample).toContain("WORKER_HOST");
    expect(envExample).toContain("loopback");
    expect(envExample).toContain("OMIE_APP_KEY");
    expect(envExample).toContain("OMIE_APP_SECRET");
    expect(envExample).toContain("VITE_SUPABASE_URL");
    expect(envExample).toContain("VITE_SUPABASE_ANON_KEY");
    expect(envExample).not.toMatch(/VITE_.*SERVICE_ROLE/);
    expect(envExample).not.toMatch(/OMIE_APP_SECRET=\S+/);
  });

  it("pins Fly api autostop and worker always-on single machine in fly.toml", () => {
    const apiFly = readFileSync(join(srcRoot, "../../../apps/api/fly.toml"), "utf8");
    const workerFly = readFileSync(join(srcRoot, "../../../apps/worker/fly.toml"), "utf8");
    expect(apiFly).toContain('primary_region = "gru"');
    expect(apiFly).toContain("auto_stop_machines = true");
    expect(apiFly).toContain("auto_start_machines = true");
    expect(apiFly).toContain("min_machines_running = 0");
    expect(apiFly).toContain("internal_port = 3000");
    expect(workerFly).toContain('primary_region = "gru"');
    expect(workerFly).toContain("auto_stop_machines = false");
    expect(workerFly).toContain("min_machines_running = 1");
    expect(workerFly).toContain("internal_port = 3001");
    expect(workerFly).toContain("force_https = true");
  });

  it("requires a gitleaks secret-scan job in CI for the credential names", () => {
    const ci = readFileSync(join(srcRoot, "../../../.github/workflows/ci.yml"), "utf8");
    const gitleaks = readFileSync(join(srcRoot, "../../../.gitleaks.toml"), "utf8");
    expect(ci).toContain("secret-scan:");
    expect(ci).toContain("gitleaks");
    const secretJob = ci.slice(ci.indexOf("secret-scan:"), ci.indexOf("lint-and-test:"));
    expect(secretJob).not.toContain("continue-on-error");
    expect(gitleaks).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(gitleaks).toContain("DATABASE_URL");
    expect(gitleaks).toContain("AUTHENTICATION_API_KEY");
    expect(gitleaks).toContain("EVOLUTION_WEBHOOK_SECRET");
    expect(gitleaks).toContain("OPENAI_API_KEY");
    expect(gitleaks).toContain("OMIE_APP_SECRET");
    expect(gitleaks).toContain("FLY_API_TOKEN");
  });

  it("does not expose the Auth service-role key as a VITE_ value in product source", () => {
    const offenders = walk(srcRoot).filter((file) =>
      /VITE_[A-Z0-9_]*SERVICE_ROLE|VITE_SUPABASE_SERVICE_ROLE/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("bundles Inter and wraps the SPA in ThemeProvider", () => {
    const main = readFileSync(join(srcRoot, "main.tsx"), "utf8");
    const providers = readFileSync(join(srcRoot, "AppProviders.tsx"), "utf8");
    expect(main).toContain("@fontsource/inter");
    expect(main).toContain("AppProviders");
    expect(providers).toContain("ThemeProvider");
  });

  it("does not load Inter from a Google Fonts URL", () => {
    const offenders = walk(srcRoot).filter((file) => GOOGLE_FONTS.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
