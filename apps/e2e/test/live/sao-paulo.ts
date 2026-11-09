/**
 * America/Sao_Paulo calendar date and clock for the Programar mensagem inputs.
 */

/**
 * Formats an instant as the `Data` / `Hora` values the schedule dialog stores.
 *
 * @param at - Instant to project into America/Sao_Paulo (no DST)
 * @returns `date` as `YYYY-MM-DD` and `time` as `HH:mm`
 */
export function saoPauloDateAndTime(at: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}
