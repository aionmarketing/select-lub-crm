/**
 * Persistence port for the mock catalog, the Motul and Tecfil compatibility caches, and frozen quotes.
 */
import type { StoredManualReading } from "./manual-readings.js";
import type { CatalogItem, CitedSource, FilterDetail, GradeSource, LubricantDetail, MotulCompatibility, OilQuote, TecfilCompatibility, SearchMissInsert, SearchMissRow, SourceCandidateInsert, SourceCandidateRow } from "../../contracts/http.js";

/**
 * A CompatibilidadeMotul row as the store reads it back: the per-grade provenance is always
 * filled, derived from the primary source on a row written before it was recorded.
 */
export type CachedCompatibility = MotulCompatibility & {
  gradeSources: GradeSource[];
  litersSource: CitedSource | null;
};

/**
 * A catalog row read for matching: the generic item plus whichever detail child it carries.
 * An item is a lubricant exactly when `lubricant` is set and a filter exactly when `filter`
 * is set; it never carries both, so at most one of the two is non-null.
 */
export type CatalogRow = CatalogItem & {
  lubricant: LubricantDetail | null;
  filter: FilterDetail | null;
};

/** Make/year/model/version identity used as the key of both compatibility caches.
 * Optional `displacementCc` / `fuel` come from a cached plate lookup and are
 * forwarded to Motul only; they are not part of the cache key. */
export type VehicleIdentity = {
  make: string;
  year: number;
  model: string;
  version: string;
  displacementCc?: number;
  fuel?: string;
  /**
   * The engine the attendant picked, on an engine re-read only (background-oil-research D24): the
   * extractor is told to read that engine's values. Never part of the cache key.
   */
  engine?: string;
};

/** Persistence port for catalog rows, the two compatibility caches, and oil quotes. */
export type OilQuoteStore = {
  /**
   * Lists every catalog row (active and inactive, oils, filters and neither) with its details.
   * @returns Catalog items as shared-types DTOs, each carrying `lubricant` and `filter`, either of which may be `null`.
   */
  listCatalog(): Promise<CatalogRow[]>;
  /**
   * Loads one catalog row by id.
   * @param id - Catalog item id.
   * @returns The row, or `null` when missing.
   */
  getCatalogItem(id: string): Promise<CatalogItem | null>;
  /**
   * Returns the latest CompatibilidadeMotul row whose identity matches (Motul normalize).
   * @param identity - CRM make/year/model/version.
   * @returns Latest matching cache row, or `null`.
   */
  latestCompatibility(identity: VehicleIdentity): Promise<CachedCompatibility | null>;
  /**
   * Inserts a new CompatibilidadeMotul row; does not update prior rows.
   * @param row - Cache fields without id/createdAt. Omitting `gradeSources` records none,
   * and the row then reads as one provenance, its primary source.
   */
  insertCompatibility(row: Omit<MotulCompatibility, "id">): Promise<CachedCompatibility>;
  /**
   * Returns the latest CompatibilidadeTecfil row whose identity matches, under the same
   * normalize rule as {@link OilQuoteStore.latestCompatibility}.
   * @param identity - CRM make/year/model/version.
   * @returns Latest matching cache row, or `null` when none matches.
   */
  latestTecfilCompatibility(identity: VehicleIdentity): Promise<TecfilCompatibility | null>;
  /**
   * Inserts a new CompatibilidadeTecfil row; insert-only, so prior rows for the same
   * identity stay readable as history.
   * @param row - Cache fields without id.
   */
  insertTecfilCompatibility(row: Omit<TecfilCompatibility, "id">): Promise<TecfilCompatibility>;
  /**
   * Records documents the retrieval found and deliberately did not read.
   *
   * Insert-only and never an update: finding the same URL again on a later quote adds a
   * row, so what was visible when stays legible. Writing none is a no-op.
   *
   * @param rows - Candidates without ids.
   */
  insertSourceCandidates(rows: readonly SourceCandidateInsert[]): Promise<SourceCandidateRow[]>;
  /**
   * Lists the candidates recorded for one identity, newest first.
   *
   * Internal only — candidates never reach the quote-options HTTP contract.
   *
   * @param identity - CRM make/year/model/version.
   */
  listSourceCandidates(identity: VehicleIdentity): Promise<SourceCandidateRow[]>;
  /**
   * Remembers that a web search for this identity found nothing usable.
   *
   * @param row - The miss without an id.
   */
  recordSearchMiss(row: SearchMissInsert): Promise<SearchMissRow>;
  /**
   * Returns the most recent remembered miss for an identity, or `null`.
   *
   * A miss is NOT a cache row: the caller uses it only to skip a repeat search, never to
   * offer the attendant a previous result.
   *
   * @param identity - CRM make/year/model/version.
   */
  latestSearchMiss(identity: VehicleIdentity): Promise<SearchMissRow | null>;
  /**
   * The verified readings of stored manuals for an identity (same normalize rule as the
   * caches), each with its extraction, cited page and passage. A quote uses them as sources
   * without calling a model (ingest-harvested-manuals D7).
   * @param identity - CRM make/year/model/version.
   */
  listManualReadings(identity: VehicleIdentity): Promise<StoredManualReading[]>;
  /**
   * Persists a quote with frozen line snapshots.
   * @param input.createdByUserId - Attendant uuid from the auth hook.
   */
  createQuote(input: {
    customerId: string;
    vehicleId: string;
    conversationId: string | null;
    generatedMessageText: string;
    createdByUserId: string;
    lines: Array<{ catalogItemId: string; brand: string; description: string; price: number }>;
  }): Promise<OilQuote>;
};
