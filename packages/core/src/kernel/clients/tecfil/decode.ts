/**
 * Undoes the Tecfil Catálogo Expresso response obfuscation: base64, split on
 * `<!1!>`, two block-rotation passes, base64 again. Scrambling, not
 * encryption — no key, and the routine ships in the site's own public bundle
 * (see `docs/tecfil-catalogo-expresso-api.md`, "Response encoding"). Error
 * bodies skip the wrapper and arrive as plain JSON, so any body starting
 * with `{` or `[` is parsed directly instead.
 */

const SEP_FILTRO = "<!1!>";

/** Thrown when a response body cannot be decoded as an obfuscated Tecfil body or plain JSON. */
export class TecfilDecodeError extends Error {
  constructor(reason: string) {
    super(`tecfil decode: ${reason}`);
  }
}

/**
 * Walks `offsets` in reverse; for each offset `n`, moves the last `n`
 * characters of the running string to the front. Mirrors the site's own
 * `_rot` helper exactly (order and direction matter — this is not a generic
 * rotate).
 */
function rotate(s: string, offsets: number[]): string {
  let out = s;
  for (let i = offsets.length - 1; i >= 0; i--) {
    const cut = out.length - offsets[i];
    out = out.slice(cut) + out.slice(0, cut);
  }
  return out;
}

/**
 * Decodes one Tecfil `/consulta` (or `/obtemConfigFiles` / `/termos-trad` /
 * `/informativos`) response body into its JSON payload.
 *
 * @param body - Raw HTTP response text.
 * @returns Parsed JSON value: the decoded envelope for an obfuscated body, or
 *   the body itself when it already starts with `{` or `[` (Tecfil's
 *   unwrapped error shape).
 * @throws {@link TecfilDecodeError} when the body is neither valid unwrapped
 *   JSON nor a well-formed three-part obfuscated envelope.
 */
export function decodeTecfilBody(body: string): unknown {
  const trimmed = body.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new TecfilDecodeError(
        `unwrapped body is not valid JSON: ${(err as Error).message}`,
      );
    }
  }

  let unwrapped: string;
  try {
    unwrapped = Buffer.from(trimmed, "base64").toString("utf8");
  } catch (err) {
    throw new TecfilDecodeError(
      `outer base64 decode failed: ${(err as Error).message}`,
    );
  }

  const parts = unwrapped.split(SEP_FILTRO);
  if (parts.length !== 3) {
    throw new TecfilDecodeError(
      `expected 3 parts after splitting on ${SEP_FILTRO}, got ${parts.length}`,
    );
  }
  const [rawOffsets0, scrambled, rawOffsets2] = parts;

  let offsets0: number[];
  let offsets2: number[];
  try {
    offsets0 = JSON.parse(rawOffsets0) as number[];
    offsets2 = JSON.parse(rawOffsets2) as number[];
  } catch (err) {
    throw new TecfilDecodeError(
      `rotation offset arrays are not valid JSON: ${(err as Error).message}`,
    );
  }

  const rotated = rotate(rotate(scrambled, offsets2), offsets0);

  let inner: string;
  try {
    inner = Buffer.from(rotated, "base64").toString("utf8");
  } catch (err) {
    throw new TecfilDecodeError(
      `inner base64 decode failed: ${(err as Error).message}`,
    );
  }

  try {
    return JSON.parse(inner);
  } catch (err) {
    throw new TecfilDecodeError(
      `decoded body is not valid JSON: ${(err as Error).message}`,
    );
  }
}
