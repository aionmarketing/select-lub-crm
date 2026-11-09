/**
 * Reads `emp01`–`emp04` quoted PascalCase tables from `tid_archive` into one pile.
 */
import type { Client } from "pg";
import type {
  TidsciArchive,
  TidsciAutoRow,
  TidsciClientSnap,
  TidsciNfHeader,
  TidsciNfItem,
  TidsciStockRow,
} from "./archive-rows.js";

const SCHEMAS = ["emp01", "emp02", "emp03", "emp04"] as const;

function asText(value: unknown) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function asNumber(value: unknown) {
  if (value == null || value === "") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function unionSelect(table: string, columns: string) {
  return SCHEMAS.map(
    (schema) =>
      `SELECT '${schema}' AS archive_schema, ${columns} FROM ${schema}.${table}`,
  ).join("\nUNION ALL\n");
}

/**
 * Loads every NF / client snap / item / auto / stock row from the four company schemas.
 *
 * @param client - Connected `pg` client on `TID_ARCHIVE_DATABASE_URL` (not `DATABASE_URL`).
 * @returns One in-memory tenant pile for {@link mapTidsciArchive}.
 */
export async function readTidsciArchive(client: Client): Promise<TidsciArchive> {
  const snapsResult = await client.query(
    unionSelect(
      `"NotaFiscalSaidasDadosClientes"`,
      `"CODIGOCLIENTE"::text AS codigo_cliente, "RAZAOSOCIAL" AS razao_social, "CPF" AS cpf, "CGC" AS cgc, "ENDERECO" AS endereco, "BAIRRO" AS bairro, "CIDADE" AS cidade, "CODIGOUF" AS codigo_uf, "CEP" AS cep`,
    ),
  );
  const nfsResult = await client.query(
    unionSelect(
      `"NotaFiscalSaidas"`,
      `"NRPEDIDO"::text AS nr_pedido, "CODIGOCLIENTE"::text AS codigo_cliente, "VALORTOTALNOTA" AS valor_total, COALESCE("DATAEMISSAO", "DATAEMISSAONF") AS data_emissao, "TelefoneContatoVenda" AS telefone, "EmailContatoVenda" AS email`,
    ),
  );
  const itemsResult = await client.query(
    unionSelect(
      `"NotaFiscalSaidasItens"`,
      `"NRPEDIDO"::text AS nr_pedido, "CODIGOMATERIAL"::text AS codigo_material, "DESCRICAO" AS descricao, "QTDEITEM" AS qtde, "VALORUNITARIO" AS valor_unitario, "VALORTOTALITEM" AS valor_total`,
    ),
  );
  const autosResult = await client.query(
    unionSelect(
      `"DadosPedidosAutomotivo"`,
      `"NRPEDIDO"::text AS nr_pedido, "Placa" AS placa, "MARCAMODELOVEICULO" AS marca_modelo, "QUILOMETRAGEMVEICULO" AS km, "ANOFABRICACAOANOMODELO" AS ano`,
    ),
  );
  const stockResult = await client.query(
    unionSelect(
      `"EstoqueMateriais"`,
      `"CODIGOMATERIAL"::text AS codigo_material, "ESTOQUE" AS estoque`,
    ),
  );

  const snapByCode = new Map<string, number | null>();
  const nfs: TidsciNfHeader[] = nfsResult.rows.map((row: Record<string, unknown>) => {
    const header: TidsciNfHeader = {
      schema: String(row.archive_schema),
      nrPedido: asText(row.nr_pedido) ?? "",
      codigoCliente: asText(row.codigo_cliente) ?? "",
      valorTotalNota: asNumber(row.valor_total),
      dataEmissao: asNumber(row.data_emissao),
      telefoneContatoVenda: asText(row.telefone),
      emailContatoVenda: asText(row.email),
    };
    const key = `${header.schema}|${header.codigoCliente}`;
    const prev = snapByCode.get(key);
    if (prev == null || (header.dataEmissao != null && header.dataEmissao >= (prev ?? Number.NEGATIVE_INFINITY))) {
      snapByCode.set(key, header.dataEmissao);
    }
    return header;
  });

  const snaps: TidsciClientSnap[] = snapsResult.rows.map((row: Record<string, unknown>) => {
    const schema = String(row.archive_schema);
    const codigoCliente = asText(row.codigo_cliente) ?? "";
    return {
      schema,
      codigoCliente,
      razaoSocial: asText(row.razao_social),
      cpf: asText(row.cpf),
      cgc: asText(row.cgc),
      endereco: asText(row.endereco),
      bairro: asText(row.bairro),
      cidade: asText(row.cidade),
      codigoUf: asText(row.codigo_uf),
      cep: asText(row.cep),
      dateInteger: snapByCode.get(`${schema}|${codigoCliente}`) ?? null,
    };
  });

  const items: TidsciNfItem[] = itemsResult.rows.map((row: Record<string, unknown>) => ({
    schema: String(row.archive_schema),
    nrPedido: asText(row.nr_pedido) ?? "",
    codigoMaterial: asText(row.codigo_material),
    descricao: asText(row.descricao) ?? "",
    qtdeItem: asNumber(row.qtde),
    valorUnitario: asNumber(row.valor_unitario),
    valorTotalItem: asNumber(row.valor_total),
  }));

  const autos: TidsciAutoRow[] = autosResult.rows.map((row: Record<string, unknown>) => ({
    schema: String(row.archive_schema),
    nrPedido: asText(row.nr_pedido) ?? "",
    placa: asText(row.placa),
    marcaModeloVeiculo: asText(row.marca_modelo),
    quilometragem: asNumber(row.km),
    anoFabricacaoAnoModelo: asNumber(row.ano),
  }));

  const stock: TidsciStockRow[] = stockResult.rows.map((row: Record<string, unknown>) => ({
    schema: String(row.archive_schema),
    codigoMaterial: asText(row.codigo_material) ?? "",
    estoque: asNumber(row.estoque),
  }));

  return { snaps, nfs, items, autos, stock };
}

/**
 * Counts `NotaFiscalSaidas` rows per schema for generate-run verification.
 *
 * @param client - Connected `pg` client on `tid_archive`.
 * @returns Map of schema name to header count.
 */
export async function countNotaFiscalSaidasBySchema(client: Client) {
  const counts: Record<string, number> = {};
  for (const schema of SCHEMAS) {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${schema}."NotaFiscalSaidas"`);
    counts[schema] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}
