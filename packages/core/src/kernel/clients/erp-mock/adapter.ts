/**
 * Port interfaces for talking to Omie and recording integration errors.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { CrmFieldValue, OmieClientSnapshot } from "./map.js";

/** Outcome of a partial Omie write — lists shared keys Omie rejected and optional per-key reasons. */
export type OmiePutResult = {
  failedKeys: OmieSharedFieldKey[];
  reasons?: Partial<Record<OmieSharedFieldKey, string>>;
};

/** One Omie client row as returned by a list or consult call, with its parsed snapshot. */
export type OmieListedClient = {
  omieId: string;
  snapshot: OmieClientSnapshot;
  codigoIntegracao?: string;
};

/** One page of Omie clients plus pagination metadata for pull and match flows. */
export type OmieListPage = {
  clients: OmieListedClient[];
  page: number;
  totalPages: number;
};

/** Payload persisted when an Omie HTTP call or sync step fails. */
export type IntegrationErrorInput = {
  operation: string;
  code: string;
  message: string;
  retryable: boolean;
  attemptCount: number;
  correlationId?: string | null;
};

/** Sink that records integration errors for later inspection or alerting. */
export type IntegrationErrorSink = {
  /**
   * Persists one integration error row.
   *
   * @param error - Operation label, machine code, human message, retry hint, attempt count, and optional correlation id.
   * @returns Resolves when the row is stored; implementations must not throw on duplicate or malformed input.
   */
  record(error: IntegrationErrorInput): Promise<void>;
};

/** Minimal Omie client access used by the bidirectional sync engine. */
export type OmieAdapter = {
  /**
   * Fetches the current Omie wire snapshot for a linked client.
   *
   * @param omieId - Omie `codigo_cliente_omie` as a decimal string; must not be empty.
   * @returns Parsed client snapshot, or `null` when Omie has no row for that id.
   * @throws Omie HTTP faults (`omie_425`, `omie_429`, sanitized fault strings) from the HTTP adapter; `omie_unavailable` from the fake adapter after `failPuts()`.
   */
  get(omieId: string): Promise<OmieClientSnapshot | null>;
  /**
   * Pushes changed shared fields to Omie and returns any keys Omie rejected without throwing.
   *
   * @param omieId - Omie client id to alter; fake adapter creates an empty snapshot when missing.
   * @param fields - Partial map of shared keys to CRM values; keys omitted are not sent on the wire.
   * @param codigoIntegracao - Optional CRM integration code (`codigo_cliente_integracao`); omit when not linking by CRM id.
   * @returns `failedKeys` lists rejected fields; `reasons` maps keys to Omie or mapping errors when present. Empty `failedKeys` means every submitted key succeeded.
   * @throws Omie HTTP faults from the HTTP adapter when the alter call fails; `omie_unavailable` from the fake adapter after `failPuts()`.
   */
  put(
    omieId: string,
    fields: Partial<Record<OmieSharedFieldKey, CrmFieldValue>>,
    codigoIntegracao?: string,
  ): Promise<OmiePutResult>;
};

/** Full Omie client port — read/write plus paginated list and create for pull and link flows. */
export type OmieSyncPort = OmieAdapter & {
  /**
   * Lists one page of Omie clients, optionally restricted to rows altered after a date.
   *
   * @param page - 1-based page index passed as Omie `pagina`.
   * @param filter - When `alteredAfter` is set, Omie filters by alteration date (`filtrar_por_data_alteracao`); omit for an unfiltered page.
   * @returns Client rows for the page plus Omie `pagina` and `total_de_paginas`.
   * @throws Omie HTTP faults from the HTTP adapter.
   */
  listPage(page: number, filter?: { alteredAfter?: string }): Promise<OmieListPage>;
  /**
   * Creates a new Omie client from a CRM integration code and snapshot.
   *
   * @param input.codigoIntegracao - Unique CRM-side integration code (`codigo_cliente_integracao`); must not be empty.
   * @param input.snapshot - Full Omie wire snapshot to send on include.
   * @returns Assigned Omie `codigo_cliente_omie` as a string.
   * @throws `omie_incluir_no_id` when Omie returns no id; other Omie HTTP faults from the HTTP adapter.
   */
  incluir(input: {
    codigoIntegracao: string;
    snapshot: OmieClientSnapshot;
  }): Promise<{ omieId: string }>;
};
