/**
 * Omie pull job — paginates clients from Omie into the cadastro store and links unlinked CRM rows.
 */
import type { OmieListedClient, OmieSyncPort } from "../../../kernel/clients/erp-mock.js";
import { ingestOmieSnapshot } from "../../customers/contracts/cadastro-engine/index.js";
import { digitsOnly } from "../../../kernel/clients/erp-mock.js";
import type {
  CadastroStore,
  CustomerRecord,
  MatchCandidateScope,
} from "../../customers/contracts/cadastro-store/port.js";
import type { SyncRunStore } from "../contracts/sync-run-store.js";

/**
 * Runs a full or incremental Omie client pull, applying snapshots then matching unlinked customers.
 *
 * @param input.mode - `"full"` lists every page; `"incremental"` filters by the last completed run window.
 * @param input.store - Cadastro persistence port receiving upserts.
 * @param input.adapter - Omie list/create port for pagination and match pushes.
 * @param input.sync - Run and error recorder for progress and failure rows.
 * @param input.now - Clock override for `windowTo`; defaults to `new Date()`.
 * @param input.matchScope - Restricts the match pass to these customers. Production
 *   omits it: matching is database-wide. See {@link MatchCandidateScope}.
 * @param input.log - Where the match pass's skip lines go; defaults to `console.warn`.
 * @returns The completed run id and totals after the match pass finishes.
 * @throws Re-throws the underlying Omie or store error after marking the run `failed` and recording `omie_pull_failed`.
 */
export async function pullOmieClients(input: {
  mode: "full" | "incremental";
  store: CadastroStore;
  adapter: OmieSyncPort;
  sync: SyncRunStore;
  now?: Date;
  matchScope?: MatchCandidateScope;
  log?: (message: string) => void;
}): Promise<{
  id: string;
  status: "completed";
  totals: { read: number; written: number; errors: number };
  windowTo: string;
}> {
  const now = input.now ?? new Date();
  const previous = input.mode === "incremental" ? await input.sync.latestCompleted("cliente") : null;
  const alteredAfter = input.mode === "incremental" ? previous?.windowTo ?? previous?.createdAt ?? null : null;
  const run = await input.sync.startRun({
    source: "OMIE",
    entity: "cliente",
    mode: input.mode,
    windowFrom: alteredAfter,
  });

  let read = 0;
  let written = 0;
  let errors = 0;
  try {
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const listed = await input.adapter.listPage(
        page,
        alteredAfter ? { alteredAfter } : undefined,
      );
      totalPages = listed.totalPages;
      read += listed.clients.length;
      for (const client of listed.clients) {
        if (client.omieId === "") {
          continue;
        }
        const existing = await input.store.findCustomerByOmieId(client.omieId);
        if (existing) {
          await ingestOmieSnapshot(input.store, input.adapter, existing.id);
        } else {
          await input.store.upsertByOmieId({ omieId: client.omieId, snapshot: client.snapshot });
        }
        written += 1;
      }
      await input.sync.updateRun(run.id, { cursor: String(page) });
      page += 1;
    }
    await matchUnlinkedCustomers({
      store: input.store,
      adapter: input.adapter,
      errors: input.sync,
      ...(input.matchScope ? { scope: input.matchScope } : {}),
      ...(input.log ? { log: input.log } : {}),
    });
    const windowTo = now.toISOString();
    await input.sync.updateRun(run.id, {
      status: "completed",
      windowTo,
      totals: { read, written, errors },
    });
    return { id: run.id, status: "completed", totals: { read, written, errors }, windowTo };
  } catch (error: unknown) {
    errors += 1;
    await input.sync.record({
      operation: "pullOmieClients",
      code: "omie_pull_failed",
      message: error instanceof Error ? error.message : "unknown",
      retryable: true,
      attemptCount: 1,
      correlationId: run.id,
    });
    await input.sync.updateRun(run.id, {
      status: "failed",
      totals: { read, written, errors },
    });
    throw error;
  }
}

/**
 * Links unlinked CRM customers to Omie by tax id or phone match, or pushes them to Omie when no match exists.
 *
 * @param input.store - Cadastro port listing candidates and saving links.
 * @param input.adapter - Omie port for full client list and `incluir` creates.
 * @param input.errors - Error sink for ambiguous or already-linked matches; does not throw on per-customer failures.
 * @param input.scope - Only these customers are candidates. Omitted in production,
 *   where every unlinked customer is (database-wide).
 * @param input.log - Receives `omie_match_no_key customer=<id>` for each candidate
 *   skipped for having no usable key; defaults to `console.warn`.
 * @returns Resolves when every candidate has been linked, created in Omie, or logged as an error.
 */
export async function matchUnlinkedCustomers(input: {
  store: CadastroStore;
  adapter: OmieSyncPort;
  errors: { record: SyncRunStore["record"] };
  scope?: MatchCandidateScope;
  log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? ((message: string) => console.warn(message));
  const candidates = await input.store.listUnlinkedMatchCandidates(input.scope);
  if (candidates.length === 0) {
    return;
  }
  const listed = await collectAllClients(input.adapter);
  for (const customer of candidates) {
    // No usable key (owner rulings, 2026-09-25): no tax-id digits AND a primary
    // phone that normalizes to "". No Omie client can ever match it, so "zero
    // matches" would be a certainty rather than a finding, and `incluir` would
    // create an Omie client the CRM can never link back by key, on every pull.
    // Logged with the customer id only — never the tax id or phone — and not
    // recorded as an IntegrationError: it is not an integration failure, and
    // the error store's dedupe is a stub (GitHub #106), so a row per pull per
    // customer would pile up.
    const keys = keysOf(customer);
    if (keys.tax === "" && keys.phone === "") {
      log(`omie_match_no_key customer=${customer.id}`);
      continue;
    }
    const hits = matchHits(customer, listed);
    const ids = [...new Set(hits.map((hit) => hit.omieId))];
    if (ids.length === 1) {
      const omieId = ids[0]!;
      const existing = await input.store.findCustomerByOmieId(omieId);
      if (existing && existing.id !== customer.id) {
        await input.errors.record({
          operation: "match",
          code: "omie_match_already_linked",
          message: `Omie id already linked to another CRM customer`,
          retryable: false,
          attemptCount: 1,
          correlationId: customer.id,
        });
        continue;
      }
      customer.omieId = omieId;
      await input.store.saveCustomerColumns(customer);
      continue;
    }
    if (ids.length === 0) {
      const created = await input.adapter.incluir({
        codigoIntegracao: customer.id,
        snapshot: {
          razao_social: customer.name,
          cnpj_cpf: customer.taxId,
          telefone: customer.phones.find((row) => row.isPrimary)?.normalized ?? null,
          email: customer.emails.find((row) => row.isPrimary)?.normalized ?? null,
          endereco: customer.street,
          endereco_numero: customer.streetNumber,
          bairro: customer.neighborhood,
          complemento: customer.complement,
          cidade: customer.city,
          estado: customer.state,
          cep: customer.postalCode,
          codigo_pais: customer.country,
          caracteristicas: [],
        },
      });
      customer.omieId = created.omieId;
      await input.store.saveCustomerColumns(customer);
      continue;
    }
    await input.errors.record({
      operation: "match",
      code: "omie_match_ambiguous",
      message: `ambiguous Omie match for customer ${customer.id}`,
      retryable: false,
      attemptCount: 1,
      correlationId: customer.id,
    });
  }
}

async function collectAllClients(adapter: OmieSyncPort): Promise<OmieListedClient[]> {
  const first = await adapter.listPage(1);
  const clients = [...first.clients];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await adapter.listPage(page);
    clients.push(...next.clients);
  }
  return clients;
}

/**
 * The two keys a candidate is matched by: its tax id's digits and its primary
 * phone, normalized. One definition for the match and the no-key skip, so "no
 * usable key" and "can never match" cannot drift apart.
 */
function keysOf(customer: CustomerRecord): { tax: string; phone: string } {
  return {
    tax: digitsOnly(customer.taxId),
    phone: customer.phones.find((row) => row.isPrimary)?.normalized ?? "",
  };
}

function matchHits(customer: CustomerRecord, listed: OmieListedClient[]): OmieListedClient[] {
  const { tax, phone } = keysOf(customer);
  return listed.filter((client) => {
    const clientTax = digitsOnly(client.snapshot.cnpj_cpf);
    const clientPhone = digitsOnly(client.snapshot.telefone);
    const taxHit = tax !== "" && clientTax !== "" && tax === clientTax;
    const phoneHit = phone !== "" && clientPhone !== "" && phone === clientPhone;
    return taxHit || phoneHit;
  });
}
