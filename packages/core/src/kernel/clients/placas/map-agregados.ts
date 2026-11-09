/**
 * Field mapping for APIBrasil `agregados-propria`. Verified against the sandbox
 * fixture in `fixtures/agregados-propria-success.json` beside this file.
 */
import { absentPositiveInt, absentString } from "./absent.js";
import type { PlateFields } from "./port.js";
import { asRecord } from "./record.js";

/**
 * Maps the inner `data` object of an `agregados-propria` envelope onto CRM fields.
 *
 * `model` prefers a *string* `modeloDetalhes.sintetico` (sandbox), then
 * `modeloDetalhes.nome`, then `modelo`. Live `sintetico` is a boolean and must
 * not become the model name. `year` is `ano_modelo`, never `ano_fabricacao`.
 * Placeholders become absent via {@link absentString} / {@link absentPositiveInt}.
 *
 * @param data - The `json.data` node; missing or non-object yields an empty field set.
 * @returns Mapped fields with omitted keys rather than empty strings.
 */
export function mapAgregadosPropriaData(data: unknown): PlateFields {
  const row = asRecord(data);
  if (!row) {
    return {};
  }
  const details = asRecord(row.modeloDetalhes);
  const fields: PlateFields = {};
  const make = absentString(row.marca);
  if (make !== undefined) {
    fields.make = make;
  }
  const sintetico =
    typeof details?.sintetico === "string" ? absentString(details.sintetico) : undefined;
  const model = sintetico ?? absentString(details?.nome) ?? absentString(row.modelo);
  if (model !== undefined) {
    fields.model = model;
  }
  const version = absentString(row.versao);
  if (version !== undefined) {
    fields.version = version;
  }
  const year = absentPositiveInt(row.ano_modelo);
  if (year !== undefined) {
    fields.year = year;
  }
  const displacementCc = absentPositiveInt(row.cilindradas);
  if (displacementCc !== undefined) {
    fields.displacementCc = displacementCc;
  }
  const fuel = absentString(row.combustivel);
  if (fuel !== undefined) {
    fields.fuel = fuel;
  }
  return fields;
}

/**
 * Reads a reported charge that may arrive as a number or as a numeric string.
 *
 * @param value - Raw `valor_consulta` from the provider envelope.
 * @returns The charge, or null when it is absent or not a readable number.
 */
function numericCharge(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Returns whether an `agregados-propria` HTTP response consumed prepaid credit.
 *
 * Homolog (`homolog: true`), error envelopes, and non-200 statuses do not bill.
 * A live 200 with `valor_consulta` greater than 0 bills; a live 200 that omits
 * that field is treated as billed so a missing zero cannot hide a debit.
 *
 * @param httpStatus - HTTP status from the gateway.
 * @param body - Parsed JSON envelope.
 * @returns `true` when this hop should be written to the spend ledger.
 */
export function apibrasilConsumedCredit(httpStatus: number, body: unknown): boolean {
  if (httpStatus !== 200) {
    return false;
  }
  const row = asRecord(body);
  if (!row || row.homolog === true || row.error === true) {
    return false;
  }
  // A charge that is present but sent as a string — `"0"`, `"1.20"` — is still a
  // charge the provider reported, and reading it as absent billed a zero-cost
  // query. The ledger exists to reconcile spend against a prepaid balance
  // (`plate-lookup/spec.md:119`, "Every provider call that consumes credit"), so
  // recording a call that consumed nothing over-reports it.
  //
  // The fallback below is unchanged and deliberate: a genuinely absent or
  // unparseable field still bills, so a missing zero cannot hide a real debit.
  // Only a value that is present and readable is now believed.
  const charge = numericCharge(row.valor_consulta);
  if (charge !== null) {
    return charge > 0;
  }
  return true;
}
