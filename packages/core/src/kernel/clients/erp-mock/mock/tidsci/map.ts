/**
 * Pure mapper from in-memory TIDSCI archive rows to the mock Omie dataset shape.
 *
 * Visible ids are mock-origin decimal strings, not live Omie keys (GitHub #27 /
 * #29 / #5). Same-CPF codes collapse here; that is not CRM `mergedInto`.
 */
import { BRAZIL_CODIGO_PAIS, CARACTERISTICA_CAMPOS, CONTEUDO_MAX } from "../../fields.js";
import { emptySnapshot } from "../../map.js";
import { digitsOnly } from "../../sanitize.js";
import type {
  MockCatalogProduct,
  MockOmieClient,
  MockServiceOrder,
  MockServiceOrderItem,
  MockVehicleIdentifier,
} from "../dataset.js";
import { tidsciDateToIso } from "./date.js";
import { allocateOmieLookingId } from "./ids.js";
import type { TidsciArchive, TidsciAutoRow, TidsciClientSnap, TidsciNfHeader, TidsciNfItem } from "./archive-rows.js";

const OIL_KIND_RE = /oleo|óleo|5W|10W|lubrific/i;
const ITEM_VISCOSITY_RE = /\d+W-?\d+/i;

function codeKey(schema: string, codigoCliente: string) {
  return `${schema}|${codigoCliente}`;
}

function nfKey(schema: string, nrPedido: string) {
  return `${schema}|${nrPedido}`;
}

function text(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function recency(dateInteger: number | null | undefined) {
  return dateInteger ?? Number.NEGATIVE_INFINITY;
}

function clipConteudo(value: string) {
  return value.length <= CONTEUDO_MAX ? value : value.slice(0, CONTEUDO_MAX);
}

function cpf11(value: string | null | undefined) {
  const digits = digitsOnly(value);
  return digits.length === 11 ? digits : "";
}

function latestNonEmpty(
  rows: Array<{ dateInteger: number | null; value: string | null | undefined }>,
): string | null {
  let best: { date: number; value: string } | null = null;
  for (const row of rows) {
    const value = text(row.value);
    if (value === null) {
      continue;
    }
    const date = recency(row.dateInteger);
    if (!best || date >= best.date) {
      best = { date, value };
    }
  }
  return best?.value ?? null;
}

function taxIdFromSnaps(snaps: TidsciClientSnap[]) {
  const cpf = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: cpf11(snap.cpf) || null })));
  if (cpf) {
    return cpf;
  }
  return latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.cgc })));
}

function oilKindFromItems(items: TidsciNfItem[]) {
  return items.some((item) => OIL_KIND_RE.test(item.descricao)) ? "oleo" : "nf";
}

function viscosityFromDescription(description: string) {
  const match = description.match(ITEM_VISCOSITY_RE);
  return match?.[0] ?? null;
}

function mapItems(items: TidsciNfItem[]): MockServiceOrderItem[] {
  return items.map((item) => {
    const oilViscosity = viscosityFromDescription(item.descricao);
    return {
      description: item.descricao,
      kind: oilViscosity || OIL_KIND_RE.test(item.descricao) ? "oleo" : null,
      quantity: item.qtdeItem,
      unitAmount: item.valorUnitario,
      lineAmount: item.valorTotalItem,
      oilViscosity,
    };
  });
}

function plateDigits(plate: string) {
  return digitsOnly(plate) || plate.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Maps a four-schema TIDSCI pile into one mock Omie tenant.
 *
 * Catalog products are passed in (Motul seed plus generate-time cache hits); this
 * function does not call a model. Duplicate-candidate pairs are always empty —
 * collapsed CPFs must not be emitted as GitHub #5 pairs.
 *
 * @param archive - In-memory NF / snap / item / auto rows; `stock` is ignored here.
 * @param catalogProducts - Already-split flat catalog rows to copy onto the dataset.
 * @param usedIds - Optional set of already issued ids (generate fills this then allocates products).
 * @returns Clients, service orders, vehicles, the given products, and no duplicate pairs.
 */
export function mapTidsciArchive(
  archive: TidsciArchive,
  catalogProducts: MockCatalogProduct[] = [],
  usedIds = new Set<string>(),
) {
  const snapsByCode = new Map<string, TidsciClientSnap[]>();
  for (const snap of archive.snaps) {
    const codigoCliente = snap.codigoCliente.trim();
    if (codigoCliente === "") {
      continue;
    }
    const key = codeKey(snap.schema, codigoCliente);
    const list = snapsByCode.get(key) ?? [];
    list.push(snap);
    snapsByCode.set(key, list);
  }

  const cpfCodes = new Map<string, Set<string>>();
  for (const [key, snaps] of snapsByCode) {
    const cpf = cpf11(latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.cpf }))));
    if (cpf === "") {
      continue;
    }
    const group = cpfCodes.get(cpf) ?? new Set<string>();
    group.add(key);
    cpfCodes.set(cpf, group);
  }

  const codeToSource = new Map<string, string>();
  for (const [cpf, codes] of cpfCodes) {
    const source = `client|cpf|${cpf}`;
    for (const key of codes) {
      codeToSource.set(key, source);
    }
  }
  for (const key of snapsByCode.keys()) {
    if (!codeToSource.has(key)) {
      const [schema, codigoCliente] = key.split("|") as [string, string];
      codeToSource.set(key, `client|schema|${schema}|${codigoCliente}`);
    }
  }

  const sourceToCodes = new Map<string, string[]>();
  for (const [key, source] of codeToSource) {
    const list = sourceToCodes.get(source) ?? [];
    list.push(key);
    sourceToCodes.set(source, list);
  }

  const sourceToOmieId = new Map<string, string>();
  for (const source of [...sourceToCodes.keys()].sort()) {
    sourceToOmieId.set(source, allocateOmieLookingId(source, usedIds));
  }

  const nfsByCode = new Map<string, TidsciNfHeader[]>();
  for (const nf of archive.nfs) {
    const codigoCliente = nf.codigoCliente.trim();
    if (codigoCliente === "") {
      continue;
    }
    const key = codeKey(nf.schema, codigoCliente);
    const list = nfsByCode.get(key) ?? [];
    list.push(nf);
    nfsByCode.set(key, list);
  }

  const itemsByNf = new Map<string, TidsciNfItem[]>();
  for (const item of archive.items) {
    const key = nfKey(item.schema, item.nrPedido);
    const list = itemsByNf.get(key) ?? [];
    list.push(item);
    itemsByNf.set(key, list);
  }

  const autosByNf = new Map<string, TidsciAutoRow[]>();
  for (const auto of archive.autos) {
    const key = nfKey(auto.schema, auto.nrPedido);
    const list = autosByNf.get(key) ?? [];
    list.push(auto);
    autosByNf.set(key, list);
  }

  const clients: MockOmieClient[] = [];
  const vehicleIds: MockVehicleIdentifier[] = [];
  const serviceOrders: MockServiceOrder[] = [];
  const plateToVehicleOmieId = new Map<string, string>();

  for (const source of [...sourceToCodes.keys()].sort()) {
    const omieId = sourceToOmieId.get(source)!;
    const codes = (sourceToCodes.get(source) ?? []).sort();
    const snaps = codes.flatMap((key) => snapsByCode.get(key) ?? []);
    const nfs = codes.flatMap((key) => nfsByCode.get(key) ?? []);
    const autos = nfs.flatMap((nf) => autosByNf.get(nfKey(nf.schema, nf.nrPedido)) ?? []);

    const razao = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.razaoSocial })));
    const phone = latestNonEmpty(
      nfs.map((nf) => ({ dateInteger: nf.dataEmissao, value: nf.telefoneContatoVenda })),
    );
    const email = latestNonEmpty(
      nfs.map((nf) => ({ dateInteger: nf.dataEmissao, value: nf.emailContatoVenda })),
    );
    const endereco = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.endereco })));
    const bairro = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.bairro })));
    const cidade = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.cidade })));
    const estado = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.codigoUf })));
    const cep = latestNonEmpty(snaps.map((snap) => ({ dateInteger: snap.dateInteger, value: snap.cep })));

    let latestAuto: TidsciAutoRow | null = null;
    let latestAutoDate = Number.NEGATIVE_INFINITY;
    for (const nf of nfs) {
      const date = recency(nf.dataEmissao);
      for (const auto of autosByNf.get(nfKey(nf.schema, nf.nrPedido)) ?? []) {
        if (!latestAuto || date >= latestAutoDate) {
          latestAuto = auto;
          latestAutoDate = date;
        }
      }
    }

    const caracteristicas: Array<{ campo: string; conteudo: string }> = [];
    const latestPlate = text(latestAuto?.placa);
    if (latestPlate) {
      caracteristicas.push({ campo: CARACTERISTICA_CAMPOS.plate, conteudo: clipConteudo(latestPlate) });
    }
    const marcaModelo = text(latestAuto?.marcaModeloVeiculo);
    if (marcaModelo) {
      caracteristicas.push({ campo: CARACTERISTICA_CAMPOS.make, conteudo: clipConteudo(marcaModelo) });
    }
    if (latestAuto?.quilometragem != null && Number.isFinite(latestAuto.quilometragem)) {
      caracteristicas.push({
        campo: CARACTERISTICA_CAMPOS.odometerKm,
        conteudo: clipConteudo(String(latestAuto.quilometragem)),
      });
    }

    const snapshot = emptySnapshot();
    snapshot.razao_social = razao;
    snapshot.cnpj_cpf = taxIdFromSnaps(snaps);
    snapshot.telefone = phone;
    snapshot.email = email;
    snapshot.endereco = endereco;
    snapshot.bairro = bairro;
    snapshot.cidade = cidade;
    snapshot.estado = estado;
    snapshot.cep = cep;
    snapshot.codigo_pais = BRAZIL_CODIGO_PAIS;
    snapshot.caracteristicas = caracteristicas;

    const client: MockOmieClient = {
      omieId,
      alteredAt: "1970-01-01T00:00:00.000Z",
      snapshot,
    };
    clients.push(client);

    const plates = new Set<string>();
    for (const auto of autos) {
      const plate = text(auto.placa);
      if (plate) {
        plates.add(plate);
      }
    }
    for (const plate of [...plates].sort()) {
      const vehicleSource = `vehicle|${plateDigits(plate)}`;
      let vehicleOmieId = plateToVehicleOmieId.get(vehicleSource);
      if (!vehicleOmieId) {
        vehicleOmieId = allocateOmieLookingId(vehicleSource, usedIds);
        plateToVehicleOmieId.set(vehicleSource, vehicleOmieId);
      }
      vehicleIds.push({ vehicleOmieId, clientOmieId: omieId, plate });
    }
  }

  const osSources = archive.nfs
    .map((nf) => ({ nf, source: `os|${nf.schema}|${nf.nrPedido}` }))
    .sort((left, right) => left.source.localeCompare(right.source));

  for (const { nf, source } of osSources) {
    const codigoCliente = nf.codigoCliente.trim();
    if (codigoCliente === "") {
      continue;
    }
    const clientSource = codeToSource.get(codeKey(nf.schema, codigoCliente));
    if (!clientSource) {
      continue;
    }
    const clientOmieId = sourceToOmieId.get(clientSource);
    if (!clientOmieId) {
      continue;
    }
    const items = itemsByNf.get(nfKey(nf.schema, nf.nrPedido)) ?? [];
    const autos = autosByNf.get(nfKey(nf.schema, nf.nrPedido)) ?? [];
    const plate = text(autos[0]?.placa) ?? text(autos.find((row) => text(row.placa))?.placa);
    const vehicleOmieId = plate
      ? (plateToVehicleOmieId.get(`vehicle|${plateDigits(plate)}`) ?? null)
      : null;
    const odometer = autos.find((row) => row.quilometragem != null)?.quilometragem ?? null;
    const mappedItems = mapItems(items);
    const description = mappedItems[0]?.description ?? `NF ${nf.nrPedido}`;
    serviceOrders.push({
      omieId: allocateOmieLookingId(source, usedIds),
      clientOmieId,
      vehicleOmieId,
      plate: plate,
      performedAt: nf.dataEmissao == null ? null : tidsciDateToIso(nf.dataEmissao),
      description,
      kind: oilKindFromItems(items),
      status: "concluido",
      amount: nf.valorTotalNota,
      odometerKm: odometer,
      items: mappedItems,
    });
  }

  return {
    clients,
    serviceOrders,
    products: catalogProducts.map((product) => structuredClone(product)),
    vehicleIds,
    duplicatePairs: [],
  };
}
