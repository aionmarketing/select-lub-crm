/**
 * Field mapping for API Placas (`wdapi2.com.br`), taken from the published
 * documentation and the design mapping table. Not yet reconciled against a
 * live capture (change task 8.2).
 */
import { absentPositiveInt, absentString } from "./absent.js";
import type { PlateFields } from "./port.js";
import { asRecord } from "./record.js";

/**
 * Maps an API Placas JSON body onto CRM fields.
 *
 * `version` prefers `VERSAO` and falls back to `SUBMODELO`. FIPE text is never
 * used. `extra` may be absent; displacement and fuel are omitted in that case.
 *
 * @param body - Parsed JSON body; missing or non-object yields an empty field set.
 * @returns Mapped fields with omitted keys rather than empty strings.
 */
export function mapApiPlacasData(body: unknown): PlateFields {
  const row = asRecord(body);
  if (!row) {
    return {};
  }
  const extra = asRecord(row.extra);
  const fields: PlateFields = {};
  const make = absentString(row.MARCA);
  if (make !== undefined) {
    fields.make = make;
  }
  const model = absentString(row.MODELO);
  if (model !== undefined) {
    fields.model = model;
  }
  const version = absentString(row.VERSAO) ?? absentString(row.SUBMODELO);
  if (version !== undefined) {
    fields.version = version;
  }
  const year = absentPositiveInt(row.anoModelo);
  if (year !== undefined) {
    fields.year = year;
  }
  const displacementCc = extra ? absentPositiveInt(extra.cilindradas) : undefined;
  if (displacementCc !== undefined) {
    fields.displacementCc = displacementCc;
  }
  const fuel = extra ? absentString(extra.combustivel) : undefined;
  if (fuel !== undefined) {
    fields.fuel = fuel;
  }
  return fields;
}
