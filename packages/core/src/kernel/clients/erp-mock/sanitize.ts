/**
 * String helpers for Omie wire values and safe error logging.
 */
const CPF_CNPJ_DIGITS = /\d{11,14}/g;

/**
 * Returns text safe to log or persist — redacts configured secrets and masks CPF/CNPJ digit runs.
 *
 * @param raw - Raw error or response body text; empty string is returned unchanged aside from masking.
 * @param secrets - Literal secret substrings to replace with `[redacted]`; empty entries are skipped.
 * @returns Sanitized copy with secrets redacted and 11–14 digit runs replaced by `***` plus the last two digits.
 */
export function sanitizeOmieText(raw: string, secrets: string[] = []): string {
  let text = raw;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    text = text.split(secret).join("[redacted]");
  }
  return text.replace(CPF_CNPJ_DIGITS, (digits) => `***${digits.slice(-2)}`);
}

/**
 * Strips every non-digit character from a tax id, phone, or similar wire value.
 *
 * @param value - Source string; `null` and `undefined` are treated as empty.
 * @returns Digit-only string, or `""` when the input is missing or has no digits.
 */
export function digitsOnly(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value.replace(/\D/g, "");
}
