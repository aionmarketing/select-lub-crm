/**
 * Substitutes `{{nome_cliente}}` and `{{placa}}` placeholders in response templates.
 * Used by tag routes and both memory/Prisma tag stores.
 */

/**
 * Replaces known placeholders when matching values are non-null.
 *
 * @param text - Template body containing `{{nome_cliente}}` and/or `{{placa}}`.
 * @param values - Placeholder values; `null` leaves the token unchanged in the output.
 * @returns Interpolated string safe to show in a template preview.
 */
export function interpolateTemplate(
  text: string,
  values: { nome_cliente: string | null; placa: string | null },
) {
  let out = text;
  if (values.nome_cliente) {
    out = out.replaceAll("{{nome_cliente}}", values.nome_cliente);
  }
  if (values.placa) {
    out = out.replaceAll("{{placa}}", values.placa);
  }
  return out;
}
