/**
 * Encodes the Tecfil Catálogo Expresso `filtros` query parameter: a flat
 * string joined by sentinel tokens, not JSON. See
 * `docs/tecfil-catalogo-expresso-api.md` ("The filtros grammar") for the
 * reference this mirrors.
 */

const SEP_FILTRO = "<!1!>"; // between one filter and the next
const SEP_KV = "<!2!>"; // between a filter id and its value
const SEP_RANGE = "<!4!>"; // between "from" and "to" inside a collapsed range
const PREF_NEG = "<!5!>"; // prefix that negates a filter's value

/** One `filtros` entry: the value Tecfil expects, its optional code, and whether it negates. */
export interface TecfilFilterValue {
  /** Value for this filter id (a range bound when the id is `DE-*` / `ATE-*`). */
  value: string;
  /** Code paired with `value`; when present, emitted a second time as `cod<ID>`. */
  code?: string | number;
  /** Prefixes both the value and (if present) the code with `<!5!>`. */
  negate?: boolean;
}

/** Filter ids to encode, keyed by Tecfil filter id (`DE-`/`ATE-` prefix marks a range bound). */
export type TecfilFilters = Record<string, TecfilFilterValue>;

/**
 * Collapses `DE-<FIELD>` / `ATE-<FIELD>` pairs into one `<FIELD>` entry whose
 * value is `from<!4!>to`, per the API's range grammar. A lone `DE-` yields an
 * open upper bound (`from<!4!>`); a lone `ATE-` yields an open lower bound
 * (`<!4!>to`). Sending the pair uncollapsed returns all rows with `200 OK`
 * instead of failing, so this step is not optional.
 */
function collapseRanges(filters: TecfilFilters): Map<string, TecfilFilterValue> {
  const ids = Object.keys(filters);
  const deBases = new Set(
    ids.filter((id) => id.startsWith("DE-")).map((id) => id.slice(3)),
  );
  const out = new Map<string, TecfilFilterValue>();

  for (const id of ids) {
    if (id.startsWith("DE-")) {
      const base = id.slice(3);
      const from = filters[id];
      const to = filters[`ATE-${base}`]?.value ?? "";
      out.set(base, { ...from, value: `${from.value}${SEP_RANGE}${to}` });
    } else if (id.startsWith("ATE-")) {
      const base = id.slice(4);
      if (deBases.has(base)) continue; // collapsed above, under the DE- entry
      const to = filters[id];
      out.set(base, { ...to, value: `${SEP_RANGE}${to.value}` });
    } else {
      out.set(id, filters[id]);
    }
  }

  return out;
}

/**
 * Builds the `filtros` query-parameter string Tecfil expects.
 *
 * @param filters - Filter ids to their value/code/negate; `DE-`/`ATE-` prefixed
 *   ids collapse into one ranged entry.
 * @returns The `<!1!>`-joined wire string; `""` when `filters` is empty. Not
 *   URL-encoded — the caller encodes it as one query value.
 */
export function encodeFiltros(filters: TecfilFilters): string {
  const collapsed = collapseRanges(filters);
  const parts: string[] = [];

  for (const [id, v] of collapsed) {
    const neg = v.negate ? PREF_NEG : "";
    parts.push(`${id}${SEP_KV}${neg}${v.value}`);
    if (v.code !== undefined) {
      parts.push(`cod${id}${SEP_KV}${neg}${v.code}`);
    }
  }

  return parts.join(SEP_FILTRO);
}
