/**
 * AI SDK tool wrapping the Motul client's {@link resolveOil} for the Motul agent loop.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { resolveOil, type ResolveOilResult } from "../../../../kernel/clients/motul/index.js";

/** Agent-callable catalog lookup; returns missing fields or matched oil specification parts. */
export const findOil: Tool<
  {
    brand?: string;
    year?: string;
    model?: string;
    submodel?: string;
  },
  ResolveOilResult
> = tool({
  description:
    "Look up the recommended oil for a vehicle. Call it with whatever the " +
    "attendant has provided so far; it returns what is still missing or " +
    "unmatched, plus the catalog's valid options. Dependencies: 'model' " +
    "requires 'brand' and 'year'; 'submodel' requires 'model'. Infer brand " +
    "from a model name ('Argo' → FIAT), but never guess year or submodel.\n" +
    "Catalog names differ from how customers speak (customer: 'Peugeot " +
    "Passion' → catalog: '207 / Passion / SW'). If exactly one returned " +
    "option is clearly the same vehicle named, call again with " +
    "that option's exact string, verbatim — spaces, slashes, dots, and " +
    "capitalisation included. If the stated version matches no " +
    "option, do NOT substitute a similar one — the vehicle may not be in " +
    "the catalog; say so. If a field never " +
    "described has exactly one option, proceed with it but state it " +
    "so it can be corrected.\n" +
    "Never repeat a call with identical arguments; if one corrected retry " +
    "still fails, ask. On status 'unavailable', say the catalog is " +
    "unavailable and do not invent products — do not call the tool again " +
    "for this request.",
  inputSchema: z.object({
    brand: z.string().optional().describe("Vehicle make, e.g. 'FIAT'"),
    year: z
      .string()
      .optional()
      .describe("4-digit year as string, e.g. '2011'"),
    model: z
      .string()
      .optional()
      .describe("Model line. Only useful once brand and year are known."),
    submodel: z
      .string()
      .optional()
      .describe(
        "Engine/version variant, e.g. '1.4i 8V - TU3'. Only useful once model is matched.",
      ),
  }),
  execute: async (input) => resolveOil(input),
});
