/**
 * In-memory Omie adapter for local development and tests — stores snapshots in a Map.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { OmiePutResult, OmieSyncPort } from "./adapter.js";
import { CONTEUDO_MAX } from "./fields.js";
import { applyWireToSnapshot, emptySnapshot, toWire, type CrmFieldValue, type OmieClientSnapshot } from "./map.js";

/** Page size for fake `listPage`; matches the HTTP adapter's `OMIE_LIST_PAGE_SIZE`. */
const FAKE_LIST_PAGE_SIZE = 100;

/** Default alteration timestamp for `seed`, so incremental filters stay deterministic. */
const SEEDED_ALTERED_AT = "1970-01-01T00:00:00.000Z";

type FakeRow = { snapshot: OmieClientSnapshot; alteredAt: string };

/**
 * Creates a fake Omie sync port that keeps client snapshots in memory with optional put failure injection.
 *
 * `listPage` pages seeded clients in omie-id order. `incluir` assigns `fake-${codigoIntegracao}`.
 *
 * @returns `OmieSyncPort` plus test helpers: `putCount()`, `failPuts()`, `failReads()`, `seed(omieId, snapshot?, alteredAt?)`, and `snapshot(omieId)`.
 * @throws The returned `put` throws `Error("omie_unavailable")` after `failPuts()` is called. `get` / `listPage` / `incluir` throw the same after `failReads()`.
 */
export function createFakeOmie() {
  const clients = new Map<string, FakeRow>();
  let putCount = 0;
  let putThrows = false;
  let readThrows = false;

  const adapter: OmieSyncPort & {
    putCount(): number;
    failPuts(): void;
    failReads(): void;
    seed(omieId: string, snapshot?: OmieClientSnapshot, alteredAt?: string): void;
    snapshot(omieId: string): OmieClientSnapshot | undefined;
  } = {
    /**
     * Returns how many `put` calls the fake has handled.
     *
     * @returns Monotonic put counter since creation or last reset (counter is never reset by the fake).
     */
    putCount() {
      return putCount;
    },
    /**
     * Configures subsequent `put` calls to throw `omie_unavailable`.
     *
     * @returns `void`; effect is permanent until a new fake is created.
     */
    failPuts() {
      putThrows = true;
    },
    /**
     * Configures subsequent `get`, `listPage`, and `incluir` calls to throw `omie_unavailable`.
     *
     * @returns `void`; effect is permanent until a new fake is created.
     */
    failReads() {
      readThrows = true;
    },
    /**
     * Seeds or replaces the in-memory snapshot for an Omie id.
     *
     * @param omieId - Omie client id key in the fake store.
     * @param snapshot - Wire snapshot to clone; defaults to `emptySnapshot()` when omitted.
     * @param alteredAt - ISO timestamp used by incremental `listPage` filters; defaults to `1970-01-01T00:00:00.000Z`.
     * @returns `void`.
     */
    seed(omieId, snapshot = emptySnapshot(), alteredAt = SEEDED_ALTERED_AT) {
      clients.set(omieId, { snapshot: structuredClone(snapshot), alteredAt });
    },
    /**
     * Returns a clone of the stored snapshot for test assertions.
     *
     * @param omieId - Omie client id key in the fake store.
     * @returns Cloned snapshot, or `undefined` when the id was never seeded.
     */
    snapshot(omieId) {
      const row = clients.get(omieId);
      return row ? structuredClone(row.snapshot) : undefined;
    },
    /**
     * @param omieId - Omie client id to read.
     * @returns Cloned snapshot, or `null` when the id is unknown.
     */
    async get(omieId) {
      if (readThrows) {
        throw new Error("omie_unavailable");
      }
      const row = clients.get(omieId);
      return row ? structuredClone(row.snapshot) : null;
    },
    /**
     * @param omieId - Omie client id to write; creates an empty snapshot when missing.
     * @param fields - Shared fields to apply; unmapped keys land in `failedKeys`.
     * @returns `OmiePutResult` with per-key mapping failures; does not throw unless `failPuts()` was called.
     * @throws `Error("omie_unavailable")` after `failPuts()`.
     */
    async put(omieId, fields): Promise<OmiePutResult> {
      putCount += 1;
      if (putThrows) {
        throw new Error("omie_unavailable");
      }
      let row = clients.get(omieId);
      if (!row) {
        row = { snapshot: emptySnapshot(), alteredAt: SEEDED_ALTERED_AT };
        clients.set(omieId, row);
      }
      const failedKeys: OmieSharedFieldKey[] = [];
      const reasons: Partial<Record<OmieSharedFieldKey, string>> = {};
      for (const [key, value] of Object.entries(fields) as [OmieSharedFieldKey, CrmFieldValue][]) {
        const mapped = toWire(key, value);
        if (!mapped.ok) {
          failedKeys.push(key);
          reasons[key] = `conteudo exceeds ${CONTEUDO_MAX} characters`;
          continue;
        }
        applyWireToSnapshot(row.snapshot, key, mapped.wire);
      }
      row.alteredAt = new Date().toISOString();
      return failedKeys.length > 0 ? { failedKeys, reasons } : { failedKeys };
    },
    /**
     * @param page - 1-based page index.
     * @param filter - When `alteredAfter` is set, only clients with a later `alteredAt` are returned.
     * @returns One page of cloned snapshots plus `totalPages` (at least 1).
     */
    async listPage(page, filter) {
      if (readThrows) {
        throw new Error("omie_unavailable");
      }
      let rows = [...clients.entries()];
      if (filter?.alteredAfter) {
        rows = rows.filter(([, row]) => row.alteredAt > filter.alteredAfter!);
      }
      rows.sort(([a], [b]) => a.localeCompare(b));
      const totalPages = Math.max(1, Math.ceil(rows.length / FAKE_LIST_PAGE_SIZE));
      if (page < 1) {
        return { clients: [], page, totalPages };
      }
      const start = (page - 1) * FAKE_LIST_PAGE_SIZE;
      const slice = rows.slice(start, start + FAKE_LIST_PAGE_SIZE);
      return {
        clients: slice.map(([omieId, row]) => ({
          omieId,
          snapshot: structuredClone(row.snapshot),
        })),
        page,
        totalPages,
      };
    },
    /**
     * @param input.codigoIntegracao - CRM id used as the deterministic Omie id suffix.
     * @param input.snapshot - Wire snapshot stored under `fake-${codigoIntegracao}`.
     * @returns The assigned Omie id; a second include with the same code returns the same id.
     */
    async incluir(input) {
      if (readThrows) {
        throw new Error("omie_unavailable");
      }
      const omieId = `fake-${input.codigoIntegracao}`;
      const existing = clients.get(omieId);
      if (!existing) {
        clients.set(omieId, {
          snapshot: structuredClone(input.snapshot),
          alteredAt: new Date().toISOString(),
        });
      }
      return { omieId };
    },
  };

  return adapter;
}
