/**
 * What kind of document an oil-spec source is. The kernel's persistence layer tiers it and
 * the quotes contract carries it, so it lives in the shared kernel.
 *
 * Moved from `packages/shared-types/src/motul-compatibility.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/**
 * What kind of document a web-found source is, as the searching model classified it.
 *
 * This is the ONLY thing the model decides about authority: code maps the class to a tier
 * (`manufacturer_manual` 1 … `aftermarket_catalog` 5). The model never emits the number, so
 * prompt.md's rule against a model-invented confidence score is kept while its judgement
 * about *what a page is* still decides the ranking. `other` is not a member: a page the
 * model cannot place in one of these five is rejected before it becomes a source.
 */
export const sourceClassificationSchema = z.enum([
  "manufacturer_manual",
  "manufacturer_technical",
  "licensed_database",
  "lubricant_maker_guide",
  "aftermarket_catalog",
]);

/** What kind of document a web-found source is, as the searching model classified it. */
export type SourceClassification = z.infer<typeof sourceClassificationSchema>;
