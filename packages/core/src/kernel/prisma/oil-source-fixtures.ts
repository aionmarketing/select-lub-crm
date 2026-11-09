/**
 * Committed ingested sources for the demo fleet (oil-quote-liters-pricing D5).
 *
 * Each entry is a passage that was read out of a real, citable document, kept verbatim
 * alongside its citation. The quote pipeline extracts SAE grades and service-fill liters
 * *from this text*; nothing here is a spec someone typed from memory, which is why the
 * excerpt travels with the citation rather than being reduced to two numbers.
 *
 * `db:seed` reads these and opens no socket. The API uses the same entries as its
 * highest-priority retrieval adapter, so a demo vehicle quotes identically offline.
 */
import { createRequire } from "node:module";

/** One ingested passage plus the document it came from. */
export type OilSourceFixture = {
  /** Identity this passage describes, matched the same way the caches are keyed. */
  make: string;
  year: number;
  model: string;
  version: string;
  /** Who published the document. */
  publisher: string;
  /** The document itself, named as a person would cite it. */
  document: string;
  /** Page, section, or table within the document. */
  page: string;
  /** Where the passage was read from, so a reviewer can check it. */
  url: string;
  /**
   * The source's tier in the prompt.md hierarchy, 1 (manufacturer owner/service manual) to
   * 5 (reputable aftermarket catalog). Set by whoever ingests the passage, from the
   * publisher — not guessed later from the text.
   */
  authority: 1 | 2 | 3 | 4 | 5;
  /** When it was ingested, ISO-8601. */
  ingestedAt: string;
  /** The passage, verbatim. The API's extractor sees only this. */
  excerpt: string;
  /**
   * What extraction produced from {@link OilSourceFixture.excerpt}, recorded so `db:seed`
   * can reproduce a quote with no model call. A reviewer checks these against the excerpt;
   * they are never someone's recollection of what the car takes.
   */
  viscosityGrades: string[];
  classification: string;
  /** Service fill, in liters. Dry fill is never recorded here. */
  fillLiters: number;
  fillKind: "em_servico" | "unlabeled";
};

const require = createRequire(import.meta.url);

/**
 * Every committed ingested source, in priority order (owner manual first).
 *
 * @returns The fixture entries; an empty array means no demo identity is quote-capable yet,
 * which the seed and the API both report as a miss rather than inventing a spec.
 */
export function oilSourceFixtures(): OilSourceFixture[] {
  return require("../../../fixtures/oil-sources.json") as OilSourceFixture[];
}
