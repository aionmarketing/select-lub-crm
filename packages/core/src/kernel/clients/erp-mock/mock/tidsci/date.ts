/**
 * Converts TIDSCI integer invoice dates to ISO timestamps.
 *
 * Chosen epoch for the live archive cluster (~80400–82421): days since
 * 1800-01-01 (UTC). Excel's 1899-12-30 serial is tried too and rejected for
 * that cluster because it decodes to years 2120–2125, outside 2010–2026.
 */

const MS_PER_DAY = 86_400_000;
const YEAR_MIN = 2010;
const YEAR_MAX = 2026;

/** UTC midnight of 1800-01-01, the epoch kept for the TIDSCI invoice-date cluster. */
const EPOCH_DAYS_SINCE_1800 = Date.UTC(1800, 0, 1);

/** UTC midnight of 1899-12-30, Excel's serial epoch (tried, then discarded for the cluster). */
const EPOCH_EXCEL = Date.UTC(1899, 11, 30);

function utcDateFromEpoch(epochUtcMs: number, dayCount: number) {
  return new Date(epochUtcMs + dayCount * MS_PER_DAY);
}

function yearInWindow(date: Date) {
  const year = date.getUTCFullYear();
  return year >= YEAR_MIN && year <= YEAR_MAX;
}

/**
 * Converts a TIDSCI day-count integer to an ISO timestamp, or `null` when neither
 * documented epoch yields a year in 2010–2026.
 *
 * Tries days-since-1800-01-01 first (the epoch that fits ~80400–82421), then
 * Excel 1899-12-30. Does not invent a date outside that year window.
 *
 * @param dayCount - Source integer (`DATAEMISSAO` / `DATAEMISSAONF`); non-finite values return `null`.
 * @returns ISO UTC midnight, or `null` when both epochs decode outside 2010–2026.
 */
export function tidsciDateToIso(dayCount: number): string | null {
  if (!Number.isFinite(dayCount)) {
    return null;
  }
  const from1800 = utcDateFromEpoch(EPOCH_DAYS_SINCE_1800, dayCount);
  if (yearInWindow(from1800)) {
    return from1800.toISOString();
  }
  const fromExcel = utcDateFromEpoch(EPOCH_EXCEL, dayCount);
  if (yearInWindow(fromExcel)) {
    return fromExcel.toISOString();
  }
  return null;
}
