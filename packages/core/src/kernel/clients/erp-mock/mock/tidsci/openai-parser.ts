/**
 * OpenAI catalog parser used only by `tidsci:generate`. Tests inject a stub instead.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { CatalogMaterialParser } from "./catalog.js";

const catalogParseSchema = z.object({
  brand: z.string(),
  viscosity: z.string().nullable(),
  classification: z.string().nullable(),
  kind: z.enum(["oil", "filter", "other"]),
});

const SYSTEM_PROMPT =
  "Você classifica um item de nota fiscal de oficina de troca de óleo. " +
  "Devolva a marca (não use cegamente a primeira palavra), viscosidade se for óleo (ex. 5W30), " +
  "classificação só se o texto trouxer uma (API/ACEA/ILSAC), e kind oil|filter|other. " +
  "Não encurte nem reescreva a descrição da nota — o chamador já a guarda à parte.";

/**
 * Builds the generate-time OpenAI catalog parser (`OPENAI_API_KEY` / `OPENAI_MODEL`,
 * `reasoningEffort: "high"`). Same client family as worker prefill.
 *
 * @param env - Environment map with `OPENAI_API_KEY` and optional `OPENAI_MODEL`.
 * @returns Parser that never uses the invoice description as the product brand blindly.
 * @throws `"openai_unconfigured"` when `OPENAI_API_KEY` is unset.
 */
export function createOpenAiCatalogParser(
  env: NodeJS.ProcessEnv = process.env,
): CatalogMaterialParser {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("openai_unconfigured");
  }
  const openai = createOpenAI({ apiKey });
  const modelName = env.OPENAI_MODEL?.trim() || "gpt-5.6-luna";
  return async (input) => {
    const result = await generateObject({
      model: openai(modelName),
      schema: catalogParseSchema,
      system: SYSTEM_PROMPT,
      prompt: `codigo=${input.codigoMaterial}\ndescricao=${input.description}`,
      providerOptions: {
        openai: { reasoningEffort: "high" },
      },
    });
    return {
      brand: result.object.brand,
      viscosity: result.object.viscosity,
      classification: result.object.classification,
      kind: result.object.kind,
    };
  };
}
