/**
 * Contract fixtures for customers' HTTP shapes, for tests (here and in `apps/web`).
 *
 * Moved from `packages/shared-types/src/fixtures.ts` (5.1d) with declarations unchanged.
 */
import type { Customer } from "./http.customer.js";
import type { Vehicle } from "./http.vehicle.js";

// Copied from quotes' http.fixtures.ts when 5.1d split the old shared fixtures file by module:
// a private helper, so each fixtures file carries its own.
const timestamps = {
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

/** Sample customer with one primary phone and email for tests and storybook data. */
export const customerFixture = {
  id: "cus-1",
  name: "Maria Silva",
  omieId: null,
  taxId: null,
  unitId: null,
  origin: "whatsapp",
  status: "active",
  givenName: null,
  familyName: null,
  mergedInto: null,
  street: null,
  streetNumber: null,
  neighborhood: null,
  complement: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  phones: [
    {
      raw: "(11) 99999-9999",
      normalized: "11999999999",
      isPrimary: true,
    },
  ],
  emails: [
    {
      raw: "Maria@Example.com",
      normalized: "maria@example.com",
      isPrimary: true,
    },
  ],
  ...timestamps,
} satisfies Customer;

/** Sample vehicle linked to `customerFixture` with minimal identity fields. */
export const vehicleFixture = {
  id: "veh-1",
  customerId: customerFixture.id,
  omieId: null,
  plate: null,
  make: null,
  model: null,
  version: null,
  year: null,
  odometerKm: null,
  origin: "whatsapp",
  plateSourcedKeys: [],
  ...timestamps,
} satisfies Vehicle;
