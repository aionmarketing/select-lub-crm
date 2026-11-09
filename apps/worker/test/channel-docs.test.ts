/**
 * Test design (testing-strategy)
 *
 * Setup: read README.md and docs/poc-evolution-baileys.md from the repo
 * root. No Evolution HTTP.
 *
 * Spec rule (openspec/specs/channel/whatsapp-channel/spec.md):
 *   New Baileys instances request full history (BR-CH-09:
 *   "syncFullHistory": true). README points at the PEND-CH-01 decision
 *   record and that file exists.
 *
 * Partitions (one numbered group = doc strings the spec treats the same):
 *
 *   P1 VALID   — README contains the poc-evolution-baileys path AND that
 *                markdown file is on disk
 *   P2 VALID   — create-instance docs contain `"syncFullHistory": true`
 *   P3 INVALID — missing file, missing string, or `"syncFullHistory": false`
 *   P4 VALID   — .env.example + README name WORKER_OUTBOX_POLL_MS default 1000
 *                and ingest retry on WORKER_HEARTBEAT_MS 30s
 *   P5 VALID   — WORKER_HISTORY_BACKFILL is documented as opt-in; default
 *                `pnpm dev:worker` does not run the REST import; the POC doc
 *                still requires `"syncFullHistory": true` on create
 *   P6 VALID   — WORKER_OUTBOX_CLAIM_TIMEOUT_MS default 180000 (fails, never requeues) in .env.example,
 *                README, and docs/poc-evolution-baileys.md
 *   P7 VALID   — README + .env.example name OMIE_MOCK, WORKER_OMIE_POLL,
 *                WORKER_OMIE_POLL_MS (both default off; enabling the poll
 *                makes the CRM call Omie periodically). Oracle leftover
 *                "does not import Omie OS" retired by complete-omie-integration.
 *   P8 VALID   — README + .env.example name APIBRASIL_BEARER_TOKEN and
 *                PLACAS_MOCK; README names POST /plate-lookups, the operator
 *                migrate command, and API_PLACAS_TOKEN as post-MVP (factory
 *                ignores it). TIDSCI flags live on the Omie block.
 *
 * Out of scope: docker-compose.yml SYNC_FULL_HISTORY — the local Evolution
 * Compose stack was removed 2026-08-30 (Evolution is hosted); the process
 * default now lives on the hosted provider, so BR-CH-09 is documented only
 * by the instance-create samples asserted here.
 *
 * Output partitions:
 *   O1 — path exists + flag true (P1/P2)
 *   O2 — missing file / false flag (P3) — would fail the matching `it`
 *
 * Limits: none. The flag is true or not.
 *
 * Map from each `it` to a partition:
 *
 *   points README at the PEND-CH-01 decision record and that file exists — P1
 *   documents syncFullHistory: true on instance create — P2
 *   documents 1s outbox poll vs 30s ingest heartbeat — P4
 *   documents opt-in history backfill and keeps BR-CH-09 samples — P5
 *   documents 5-minute abandoned-claim reclaim timeout — P6
 *   documents Omie mock opt-in and poll toggle — P7
 *   documents plate lookup tokens, mock flag, and the operator migrate command — P8
 *
 * What would make a test fail:
 *   deleting docs/poc-evolution-baileys.md while leaving the README link
 *   `"syncFullHistory": false` in the POC doc
 *
 * Not in this file: a live POST /instance/create (PEND-CH-01 is a human
 * run); flipping the flag on a number already paired.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const readmePath = resolve(repoRoot, "README.md");
const pocPath = resolve(repoRoot, "docs/poc-evolution-baileys.md");
const envExamplePath = resolve(repoRoot, ".env.example");

describe("WhatsApp channel documentation samples", () => {
  it("points README at the PEND-CH-01 decision record and that file exists", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("docs/poc-evolution-baileys.md");
    expect(existsSync(pocPath)).toBe(true);
  });

  it("documents syncFullHistory: true on instance create", () => {
    const poc = readFileSync(pocPath, "utf8");
    expect(poc).toMatch(/"syncFullHistory"\s*:\s*true/);
    expect(readFileSync(readmePath, "utf8")).toContain("syncFullHistory");
  });

  it("documents the 1s outbox poll separately from the 30s ingest heartbeat", () => {
    const readme = readFileSync(readmePath, "utf8");
    const envExample = readFileSync(envExamplePath, "utf8");
    expect(envExample).toMatch(/WORKER_OUTBOX_POLL_MS=1000/);
    expect(envExample).toMatch(/WORKER_HEARTBEAT_MS=30000/);
    expect(readme).toContain("WORKER_OUTBOX_POLL_MS");
    expect(readme).toMatch(/default 1000 ms/);
    expect(readme).toContain("WORKER_HEARTBEAT_MS");
    expect(readme).toMatch(/30 s/);
  });

  it("documents history backfill as opt-in and keeps BR-CH-09 samples", () => {
    const readme = readFileSync(readmePath, "utf8");
    const envExample = readFileSync(envExamplePath, "utf8");
    const poc = readFileSync(pocPath, "utf8");
    expect(envExample).toContain("WORKER_HISTORY_BACKFILL");
    expect(envExample).toMatch(/opt-in|unset\/false|does not page/i);
    expect(readme).toContain("WORKER_HISTORY_BACKFILL=1");
    expect(readme).toMatch(/default `pnpm dev:worker` start does not page Evolution REST/);
    expect(poc).toMatch(/"syncFullHistory"\s*:\s*true/);
  });

  it("documents the 3-minute abandoned-claim timeout, which fails the row rather than requeuing it", () => {
    const readme = readFileSync(readmePath, "utf8");
    const envExample = readFileSync(envExamplePath, "utf8");
    const poc = readFileSync(pocPath, "utf8");
    expect(envExample).toMatch(/WORKER_OUTBOX_CLAIM_TIMEOUT_MS=180000/);
    expect(readme).toContain("WORKER_OUTBOX_CLAIM_TIMEOUT_MS");
    expect(readme).toMatch(/default 180000 ms\) become `failed` with `send_outcome_unknown`/);
    expect(poc).toContain("WORKER_OUTBOX_CLAIM_TIMEOUT_MS");
    expect(poc).toMatch(/default 180000 — abandoned `claimed` outbox rows older than this become `failed`/);
  });

  it("documents Omie HTTP as vault/env opt-in with CI fake, mock flag, and poll toggle", () => {
    const readme = readFileSync(readmePath, "utf8");
    const envExample = readFileSync(envExamplePath, "utf8");
    expect(readme).toMatch(/Omie HTTP is opt-in via vault\/env/);
    expect(readme).toMatch(/CI keeps those unset and uses the fake adapter/);
    expect(readme).toContain("OMIE_MOCK=1");
    expect(readme).toContain("OMIE_MOCK_DATASET=tidsci");
    expect(readme).toContain("WORKER_OMIE_POLL=1");
    expect(readme).toContain("WORKER_OMIE_POLL_MS");
    expect(readme).toMatch(/default off/);
    expect(readme).toMatch(/call Omie periodically/);
    expect(envExample).toContain("OMIE_APP_KEY=");
    expect(envExample).toContain("OMIE_APP_SECRET=");
    expect(envExample).toContain("OMIE_MOCK");
    expect(envExample).toContain("OMIE_MOCK_DATASET");
    expect(envExample).toContain("OMIE_MOCK_TIDSCI_PATH");
    expect(envExample).toContain("TID_ARCHIVE_DATABASE_URL");
    expect(envExample).toContain("WORKER_OMIE_POLL");
    expect(envExample).toContain("WORKER_OMIE_POLL_MS");
    expect(envExample).toMatch(/CI MUST keep both unset/);
    expect(envExample).not.toMatch(/OMIE_APP_KEY=\S+/);
    expect(envExample).not.toMatch(/OMIE_APP_SECRET=\S+/);
  });

  it("documents plate lookup tokens, mock flag, and the operator migrate command", () => {
    const readme = readFileSync(readmePath, "utf8");
    const envExample = readFileSync(envExamplePath, "utf8");
    expect(readme).toContain("APIBRASIL_BEARER_TOKEN");
    expect(readme).toContain("API_PLACAS_TOKEN");
    expect(readme).toMatch(/API_PLACAS_TOKEN[\s\S]{0,80}post-MVP/);
    expect(readme).toContain("PLACAS_MOCK=1");
    expect(readme).toContain("POST /plate-lookups");
    expect(readme).toContain("pnpm db:migrate");
    expect(envExample).toContain("APIBRASIL_BEARER_TOKEN");
    expect(envExample).toContain("API_PLACAS_TOKEN");
    expect(envExample).toMatch(/Post-MVP fallback/);
    expect(envExample).toContain("PLACAS_MOCK");
    expect(envExample).not.toMatch(/APIBRASIL_BEARER_TOKEN=\S+/);
    expect(envExample).not.toMatch(/API_PLACAS_TOKEN=\S+/);
  });
});
