/**
 * Playwright config for the ONE tour that needs a disconnected WhatsApp channel.
 *
 * Why a whole config for a single file: the Conversas screen reads its channel
 * state from `channelStatus()`, which resolves the connection by
 * `EVOLUTION_INSTANCE_NAME` (`conversations/prisma.ts:454`) — one CONFIGURED
 * instance, not "whichever connection belongs to this unit". So the state the
 * refusal paths depend on is a property of the API PROCESS, and the only ways to
 * reach it are to point a process at a disconnected instance, which is this
 * file, or to flip the shared connection's state mid-run, which would break
 * every other tour and leave the database wrong whenever a run failed partway.
 *
 * **Seeding a second connection does NOT work, and is not merely ineffective.**
 * `channelStatus()` would keep reading the configured instance and see
 * `CONNECTED`, so there would be nothing to tour. Worse, `create()` — Nova
 * conversa, `prisma.ts:453` — resolves the unit's connection with
 * `findFirst({ where: { unitId } })` and NO ordering, so an extra connection in
 * that unit joins an unordered pick that `conversas-inbox.tour.spec.ts` depends
 * on. Measured 2026-09-16: that unit already holds two connections and
 * `findFirst` returns the one that is NOT configured. They agree today only
 * because both are `CONNECTED`.
 *
 * Own ports (3101 / 5175 / 18082) so this stack can run beside the main tour
 * stack and `pnpm dev`. Same provider guard as every other tour, imported rather
 * than copied.
 *
 * Invoke with `pnpm test:e2e:tours:disconnected`.
 */
import { E2E } from "./test/ids.js";
import { defineTourConfig } from "./tours-config.shared.js";

export default defineTourConfig({
  apiPort: 3101,
  webPort: 5175,
  evolutionPort: 18082,
  testMatch: "**/conversas-channel-down.tour.spec.ts",
  outputDir: "test-results/tours-disconnected",
  // The whole point of this config. The seed creates this instance in a
  // non-CONNECTED state and leaves the default instance CONNECTED, so every
  // other tour is untouched by this one existing.
  apiEnv: { EVOLUTION_INSTANCE_NAME: E2E.disconnectedInstanceName },
});
