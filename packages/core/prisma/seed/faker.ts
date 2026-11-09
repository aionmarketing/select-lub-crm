/**
 * Shared pt_BR faker with a fixed seed so two plans produce the same names.
 */
import { faker } from "@faker-js/faker/locale/pt_BR";

/** Integer passed to `faker.seed` — bumping it reshuffles every demo value. */
export const DEMO_FAKER_SEED = 20_260_831;

/**
 * Resets faker to the pinned seed. Call at the start of every plan/seed run.
 */
export function resetDemoFaker() {
  faker.seed(DEMO_FAKER_SEED);
  return faker;
}

export { faker };
