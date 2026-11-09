/**
 * Test design (testing-strategy)
 *
 * Setup: stripOwnerIdentifyingKeys on the captured agregados-propria-success
 * envelope.
 *
 * Spec: plate-lookup "Stored provider payloads omit billed-party identity"
 * (`openspec/specs/plate-lookup/plate-lookup/spec.md`). Keys named there:
 * `documento_faturado`, `tipo_faturado`, `uf_faturado`, `email`, `cellphone`.
 *
 * Axes
 * A1 key presence — nested under data / already absent
 * A2 nested objects — user block kept minus email/cellphone; owner keys dropped
 * A3 container — object / array at the root / array nested under a key
 *
 * Outputs: O-keys absent; O-other fields kept
 *
 * Decision map (strip-owner.ts)
 * D1 Array.isArray(payload)   T: the two A3 array its; F: the fixture its
 * D2 null / non-object        T: reached recursing into string leaves; F: objects
 * D3 drop.has(key)            T: owner and account keys; F: marca, user.first_name
 *
 * D1-true is what the A3 rows exist for. The captured fixture nests only
 * objects, so before them an array was never handed to this function and the
 * recursion through `payload.map` had no reaching input, even though the
 * docstring promises removal "at every object level".
 *
 * Oracle: plate-lookup spec "Stored provider payloads omit billed-party
 * identity", plus the module contract at strip-owner.ts:12-16 (deep clone,
 * non-objects returned as-is). Checked against the code before use: the
 * array arm, the non-object arm and the key-drop set each match.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripOwnerIdentifyingKeys } from "./strip-owner.js";

const success = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "./fixtures/agregados-propria-success.json"),
    "utf8",
  ),
) as { json: unknown };

describe("stripOwnerIdentifyingKeys", () => {
  it("removes documento_faturado, tipo_faturado and uf_faturado from the full fixture", () => {
    const stripped = stripOwnerIdentifyingKeys(success.json) as {
      data: Record<string, unknown>;
      homolog: boolean;
    };

    expect(stripped.data.marca).toBe("VW");
    expect(stripped.data.modeloDetalhes).toEqual({
      nome: "GOL 1.0",
      sintetico: "GOL",
      origem: "chassi",
    });
    expect(stripped.data).not.toHaveProperty("documento_faturado");
    expect(stripped.data).not.toHaveProperty("tipo_faturado");
    expect(stripped.data).not.toHaveProperty("uf_faturado");
    expect(stripped.homolog).toBe(true);
    expect(JSON.stringify(stripped)).not.toContain("documento_faturado");
  });

  it("strips owner keys from objects inside an array at the root", () => {
    const stripped = stripOwnerIdentifyingKeys([
      { marca: "VW", documento_faturado: "12345678900" },
      { marca: "FIAT", uf_faturado: "SP" },
    ]);

    expect(stripped).toEqual([{ marca: "VW" }, { marca: "FIAT" }]);
    expect(JSON.stringify(stripped)).not.toContain("12345678900");
  });

  it("strips owner keys from an array nested under a key", () => {
    const stripped = stripOwnerIdentifyingKeys({
      data: { veiculos: [{ marca: "VW", tipo_faturado: "PF", email: "a@b.test" }] },
    }) as { data: { veiculos: Record<string, unknown>[] } };

    expect(stripped.data.veiculos).toEqual([{ marca: "VW" }]);
    expect(JSON.stringify(stripped)).not.toContain("a@b.test");
  });

  it("returns a primitive payload unchanged", () => {
    expect(stripOwnerIdentifyingKeys("plain")).toBe("plain");
    expect(stripOwnerIdentifyingKeys(null)).toBeNull();
  });

  it("removes account email and cellphone from the user block", () => {
    const stripped = stripOwnerIdentifyingKeys(success.json) as {
      user: Record<string, unknown>;
    };

    expect(stripped.user).not.toHaveProperty("email");
    expect(stripped.user).not.toHaveProperty("cellphone");
    expect(stripped.user.first_name).toBe("REDACTED");
    expect(stripped.user.notification).toBe("yes");
  });
});
