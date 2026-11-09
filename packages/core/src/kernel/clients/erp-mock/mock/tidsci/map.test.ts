/**
 * Test design (testing-strategy)
 *
 * Setup: `mapTidsciArchive` on a hand-written two-schema fixture. No Docker,
 *   no `tid_archive`, no network.
 *
 * Oracle: omie-mock — deterministic ids; CPF collapse; every NF is an OS;
 *   digits-only ids; skip OS with no client; oil vs nf kind; CPF preferred
 *   over CGC; phone from `TelefoneContatoVenda` or empty; catalog passed in.
 *
 * Axes
 *   A1 client key — distinct CPF / same 11-digit CPF / CGC-only
 *   A2 phone — complementary NF header / both empty
 *   A3 OS — oil item text / non-oil / header with no snap
 *   A4 date integer — cluster-decodable / undecodable
 *
 * Outputs: O1 two clients for emp01-10 vs emp02-10; O2 one collapsed client
 *   with phone and both NFs; O3 identical ids on second call; O4 oil/nf kind;
 *   O5 CPF tax id; O6 empty phone; O7 OS skipped; O8 performedAt null
 *
 * Decision map (map.ts)
 *   D1 empty CODIGOCLIENTE skip     T skip-OS it; F NF its
 *   D2 CPF 11 digits collapse       T same-CPF it; F distinct-10 it
 *   D3 CGC does not collapse        T cgc-only it
 *   D4 no snap for NF code          T skip-OS it; F mapped OS
 *   D5 oil regex on any item        T oil kind it; F nf kind it
 *   D6 date decodes                 T cluster NF; F undecodable it
 *
 * Out of scope: live archive SQL; LLM catalog parse (passed in).
 */
import { describe, expect, it } from "vitest";
import { isOmieLookingId } from "./ids.js";
import { mapTidsciArchive } from "./map.js";
import type { TidsciArchive } from "./archive-rows.js";

const CLUSTER_DATE = 80400; // 2020-02-17 via days-since-1800-01-01

function fixture(): TidsciArchive {
  return {
    snaps: [
      {
        schema: "emp01",
        codigoCliente: "10",
        razaoSocial: "Ana Emp01",
        cpf: "11144477735",
        cgc: "12345678000199",
        endereco: "Rua A",
        bairro: "Centro",
        cidade: "Campinas",
        codigoUf: "SP",
        cep: "13010000",
        dateInteger: CLUSTER_DATE,
      },
      {
        schema: "emp02",
        codigoCliente: "10",
        razaoSocial: "Bruno Emp02",
        cpf: "22233344405",
        cgc: "12345678000199",
        endereco: null,
        bairro: null,
        cidade: null,
        codigoUf: null,
        cep: null,
        dateInteger: CLUSTER_DATE,
      },
      {
        schema: "emp01",
        codigoCliente: "20",
        razaoSocial: "Carla Collapsed",
        cpf: "52998224725",
        cgc: null,
        endereco: "Rua B",
        bairro: null,
        cidade: null,
        codigoUf: null,
        cep: null,
        dateInteger: CLUSTER_DATE,
      },
      {
        schema: "emp02",
        codigoCliente: "21",
        razaoSocial: "Carla Collapsed",
        cpf: "52998224725",
        cgc: null,
        endereco: null,
        bairro: "Jardim",
        cidade: "Campinas",
        codigoUf: "SP",
        cep: "13020000",
        dateInteger: CLUSTER_DATE + 1,
      },
      {
        schema: "emp01",
        codigoCliente: "30",
        razaoSocial: "Dono CGC",
        cpf: null,
        cgc: "11222333000181",
        endereco: null,
        bairro: null,
        cidade: null,
        codigoUf: null,
        cep: null,
        dateInteger: CLUSTER_DATE,
      },
    ],
    nfs: [
      {
        schema: "emp01",
        nrPedido: "100",
        codigoCliente: "10",
        valorTotalNota: 350,
        dataEmissao: CLUSTER_DATE,
        telefoneContatoVenda: "11970000001",
        emailContatoVenda: "ana@example.com",
      },
      {
        schema: "emp02",
        nrPedido: "200",
        codigoCliente: "10",
        valorTotalNota: 80,
        dataEmissao: CLUSTER_DATE,
        telefoneContatoVenda: null,
        emailContatoVenda: null,
      },
      {
        schema: "emp01",
        nrPedido: "300",
        codigoCliente: "20",
        valorTotalNota: 200,
        dataEmissao: CLUSTER_DATE,
        telefoneContatoVenda: null,
        emailContatoVenda: null,
      },
      {
        schema: "emp02",
        nrPedido: "301",
        codigoCliente: "21",
        valorTotalNota: 210,
        dataEmissao: CLUSTER_DATE + 1,
        telefoneContatoVenda: "11988887777",
        emailContatoVenda: "carla@example.com",
      },
      {
        schema: "emp01",
        nrPedido: "400",
        codigoCliente: "30",
        valorTotalNota: 10,
        dataEmissao: 1,
        telefoneContatoVenda: null,
        emailContatoVenda: null,
      },
      {
        schema: "emp01",
        nrPedido: "999",
        codigoCliente: "missing",
        valorTotalNota: 1,
        dataEmissao: CLUSTER_DATE,
        telefoneContatoVenda: "11900000000",
        emailContatoVenda: null,
      },
    ],
    items: [
      {
        schema: "emp01",
        nrPedido: "100",
        codigoMaterial: "RAD",
        descricao: "OLEO RADNAQ 5W30 1L",
        qtdeItem: 4,
        valorUnitario: 80,
        valorTotalItem: 320,
      },
      {
        schema: "emp02",
        nrPedido: "200",
        codigoMaterial: "FIL",
        descricao: "Filtro de oleo PSL560",
        qtdeItem: 1,
        valorUnitario: 35,
        valorTotalItem: 35,
      },
      {
        schema: "emp01",
        nrPedido: "300",
        codigoMaterial: "X",
        descricao: "Servico alinhamento",
        qtdeItem: 1,
        valorUnitario: 200,
        valorTotalItem: 200,
      },
      {
        schema: "emp02",
        nrPedido: "301",
        codigoMaterial: "Y",
        descricao: "Padaria",
        qtdeItem: 1,
        valorUnitario: 210,
        valorTotalItem: 210,
      },
      {
        schema: "emp01",
        nrPedido: "400",
        codigoMaterial: "Z",
        descricao: "Jogo de tapetes",
        qtdeItem: 1,
        valorUnitario: 10,
        valorTotalItem: 10,
      },
    ],
    autos: [
      {
        schema: "emp01",
        nrPedido: "100",
        placa: "ABC1D23",
        marcaModeloVeiculo: "VW POLO 1.0",
        quilometragem: 42000,
        anoFabricacaoAnoModelo: null,
      },
    ],
    stock: [],
  };
}

describe("mapTidsciArchive", () => {
  it("emits digits-only ids that stay identical on a second call", () => {
    const first = mapTidsciArchive(fixture());
    const second = mapTidsciArchive(fixture());

    expect(first).toEqual(second);
    for (const client of first.clients) {
      expect(isOmieLookingId(client.omieId)).toBe(true);
    }
    for (const order of first.serviceOrders) {
      expect(isOmieLookingId(order.omieId)).toBe(true);
    }
    for (const vehicle of first.vehicleIds) {
      expect(isOmieLookingId(vehicle.vehicleOmieId)).toBe(true);
    }
    expect(first.duplicatePairs).toEqual([]);
  });

  it("keeps emp01 code 10 distinct from emp02 code 10 when CPFs differ", () => {
    const mapped = mapTidsciArchive(fixture());
    const ana = mapped.clients.find((row) => row.snapshot.razao_social === "Ana Emp01");
    const bruno = mapped.clients.find((row) => row.snapshot.razao_social === "Bruno Emp02");

    expect(ana?.omieId).toBeDefined();
    expect(bruno?.omieId).toBeDefined();
    expect(ana?.omieId).not.toBe(bruno?.omieId);
    expect(ana?.snapshot.cnpj_cpf).toBe("11144477735");
    expect(bruno?.snapshot.cnpj_cpf).toBe("22233344405");
  });

  it("collapses the same CPF to one client, fills complementary phone, and hangs both NFs on that id", () => {
    const mapped = mapTidsciArchive(fixture());
    const carlas = mapped.clients.filter((row) => row.snapshot.razao_social === "Carla Collapsed");

    expect(carlas).toHaveLength(1);
    expect(carlas[0]?.snapshot.telefone).toBe("11988887777");
    expect(carlas[0]?.snapshot.endereco).toBe("Rua B");
    expect(carlas[0]?.snapshot.bairro).toBe("Jardim");
    const orders = mapped.serviceOrders.filter((row) => row.clientOmieId === carlas[0]?.omieId);
    expect(orders).toHaveLength(2);
  });

  it("labels an oil NF oleo and a non-oil NF nf, prefers CPF over CGC, copies header phone, and invents none", () => {
    const mapped = mapTidsciArchive(fixture());
    const ana = mapped.clients.find((row) => row.snapshot.razao_social === "Ana Emp01")!;
    const bruno = mapped.clients.find((row) => row.snapshot.razao_social === "Bruno Emp02")!;
    const cgc = mapped.clients.find((row) => row.snapshot.razao_social === "Dono CGC")!;
    const anaOs = mapped.serviceOrders.find((row) => row.clientOmieId === ana.omieId)!;
    const brunoOs = mapped.serviceOrders.find((row) => row.clientOmieId === bruno.omieId)!;
    const cgcOs = mapped.serviceOrders.find((row) => row.clientOmieId === cgc.omieId)!;

    expect(anaOs.kind).toBe("oleo");
    expect(brunoOs.kind).toBe("oleo");
    expect(cgcOs.kind).toBe("nf");
    expect(ana.snapshot.cnpj_cpf).toBe("11144477735");
    expect(cgc.snapshot.cnpj_cpf).toBe("11222333000181");
    expect(ana.snapshot.telefone).toBe("11970000001");
    expect(bruno.snapshot.telefone).toBeNull();
    expect(cgc.snapshot.telefone).toBeNull();
  });

  it("skips an NF whose client snap is missing and leaves an undecodable date null", () => {
    const mapped = mapTidsciArchive(fixture());
    expect(mapped.serviceOrders).toHaveLength(5);
    const cgc = mapped.clients.find((row) => row.snapshot.razao_social === "Dono CGC")!;
    const cgcOs = mapped.serviceOrders.find((row) => row.clientOmieId === cgc.omieId)!;
    expect(cgcOs.performedAt).toBeNull();
    expect(cgcOs).toBeDefined();
  });

  it("copies passed-in catalog products and does not invent extra ones", () => {
    const product = {
      omieId: "1234567890",
      brand: "Radnaq",
      description: "OLEO RADNAQ 5W30 1L",
      price: 80,
      stock: 3,
      active: true,
      viscosity: "5W30",
    };
    const mapped = mapTidsciArchive(fixture(), [product]);
    expect(mapped.products).toEqual([product]);
  });
});
