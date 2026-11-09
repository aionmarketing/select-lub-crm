/**
 * The inputs a reminder's text is resolved from, read off its return.
 *
 * Shared by creating and editing a reminder message. Moved from
 * `packages/db/src/return-reminders.ts`, where both functions built these
 * inline; the values are unchanged.
 */

/** The vehicle as it should read inside the message text. */
export function vehicleLabel(vehicle: {
  make: string | null;
  model: string | null;
  plate: string | null;
}): string {
  return (
    [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.plate || "seu veículo"
  );
}

/**
 * The interval recorded on the return, or the six-month default.
 *
 * The rule that dated a return is recorded on it, so the recommended interval
 * is read back rather than re-matched against the service.
 *
 * @param rule - The return's interval rule, if it has one.
 * @returns Amount and unit for the text.
 */
export function returnInterval(
  rule: { intervalAmount: number; intervalUnit: string } | null,
): { amount: number; unit: "days" | "months" } {
  return rule
    ? { amount: rule.intervalAmount, unit: rule.intervalUnit === "days" ? "days" : "months" }
    : { amount: 6, unit: "months" };
}

/** How the service reads inside the message text. */
export function serviceLabel(service: { kind: string | null; description: string | null }): string {
  return service.kind ?? service.description ?? "manutenção";
}

/**
 * The calendar day of a `@db.Date` column.
 *
 * Prisma hands a `@db.Date` back as UTC midnight, so the calendar day is its
 * UTC day — reading it in São Paulo would be the day before.
 */
export function calendarDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
