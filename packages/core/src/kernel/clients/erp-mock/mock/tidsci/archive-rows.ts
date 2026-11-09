/**
 * In-memory TIDSCI archive rows the mapper accepts. Column names follow the
 * quoted PascalCase tables in `emp01`–`emp04`; this is not a Prisma schema.
 */

/** One `NotaFiscalSaidasDadosClientes` snap, tagged with its archive schema. */
export type TidsciClientSnap = {
  schema: string;
  codigoCliente: string;
  razaoSocial: string | null;
  cpf: string | null;
  cgc: string | null;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  codigoUf: string | null;
  cep: string | null;
  /** Recency key copied from the related NF date integer; `null` sorts as oldest. */
  dateInteger: number | null;
};

/** One `NotaFiscalSaidas` header. */
export type TidsciNfHeader = {
  schema: string;
  nrPedido: string;
  codigoCliente: string;
  valorTotalNota: number | null;
  dataEmissao: number | null;
  telefoneContatoVenda: string | null;
  emailContatoVenda: string | null;
};

/** One `NotaFiscalSaidasItens` line. */
export type TidsciNfItem = {
  schema: string;
  nrPedido: string;
  codigoMaterial: string | null;
  descricao: string;
  qtdeItem: number | null;
  valorUnitario: number | null;
  valorTotalItem: number | null;
};

/** One `DadosPedidosAutomotivo` row. */
export type TidsciAutoRow = {
  schema: string;
  nrPedido: string;
  placa: string | null;
  marcaModeloVeiculo: string | null;
  quilometragem: number | null;
  anoFabricacaoAnoModelo: number | null;
};

/** One `EstoqueMateriais` stock figure (generate-time catalog, not the mapper). */
export type TidsciStockRow = {
  schema: string;
  codigoMaterial: string;
  estoque: number | null;
};

/**
 * Four-schema pile the mapper treats as one mock Omie tenant.
 *
 * Unvalidated stand-in mapped from TIDSCI, not a live Omie wire contract
 * (GitHub #27 / #29 / #5).
 */
export type TidsciArchive = {
  snaps: TidsciClientSnap[];
  nfs: TidsciNfHeader[];
  items: TidsciNfItem[];
  autos: TidsciAutoRow[];
  stock: TidsciStockRow[];
};
