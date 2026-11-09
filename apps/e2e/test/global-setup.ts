/**
 * Playwright globalSetup: API/SQL fixtures after demo seed. No Evolution, no worker.
 */
import { describeDatabaseTarget } from "@select-lub/core/db";
import { seedE2eFixtures } from "./seed-e2e.js";
import { assertSeedTargetIsLocal } from "./seed-target.js";

/**
 * Seeds nameless / cadastro / send / schedule conversations and CONNECTED state.
 *
 * Resolves the target before seeding so a refusal stops the whole run at its
 * earliest point, and says where it is about to write. `packages/core/prisma/seed.ts`
 * carries the note explaining why the second half matters: on 2026-09-07 a
 * missing guard and a silent seed compounded, and either one alone would have
 * made the target visible before the rows landed. `seedE2eFixtures` guards
 * itself as well, for the per-spec auto fixture in `fixtures.ts`; this call is
 * the run-level one, and it is the only place that logs, so the announcement
 * does not repeat once per test.
 */
export default async function globalSetup() {
  // The dedicated database is named by the config module and CREATED by the
  // `test` script's provisioning step, which runs before Playwright. It cannot
  // be done here: Playwright starts `webServer` entries before globalSetup, so
  // the API would already be booting against a database that did not exist.
  const target = assertSeedTargetIsLocal();
  console.log(`e2e seed: writing Playwright fixtures to ${describeDatabaseTarget(target)}`);
  await seedE2eFixtures();
}
