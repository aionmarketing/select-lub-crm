> Copied from [ga-rodrigues-dev/tecfil-catalog-api](https://github.com/ga-rodrigues-dev/tecfil-catalog-api)
> at commit `d05423ebdf95ab711d9fc281e83f84023590fadf` (2026-09-03).
>
> **This API is unofficial, unauthenticated, and not published by Tecfil or
> Ideia2001 for programmatic use.** There are no documented rate limits and
> no terms covering this kind of access. If you build on it: throttle and
> cache (the front end itself caches with a 600-second revalidation window),
> retry once on `502` before treating it as a failure, and ask Tecfil or
> Ideia2001 first for anything sustained rather than assuming open access
> implies permission. See "Before you use this" at the end of this document.

# Catálogo Expresso API

Unofficial reference for the data API behind [catalogo.tecfil.com.br](https://catalogo.tecfil.com.br/en).

`catalogo.tecfil.com.br` is a Next.js front end for **Catálogo Expresso**, a white-label
auto-parts catalogue platform operated by Ideia2001. All catalogue data — products, vehicle
applications, cross-references, bulletins — comes from a separate, unauthenticated REST host.
The front end fetches it server-side, which is why searches never appear in the browser's
network tab.

This document was reverse-engineered from the site's client bundles and verified against the
live API on 2026-09-03. It is not published or supported by Tecfil or Ideia2001. Read
[Before you use this](#before-you-use-this) first.

**Contents**

- [Quick start](#quick-start)
- [Hosts](#hosts)
- [Authentication](#authentication)
- [Response encoding](#response-encoding)
- [The `filtros` grammar](#the-filtros-grammar)
- [Endpoints](#endpoints)
  - [`GET /consulta` — search](#get-consulta--search-idconsultapesquisa)
  - [`GET /consulta` — product detail](#get-consulta--product-detail-idconsultapesquisa_detalhes)
  - [`GET /consulta` — filter options](#get-consulta--filter-options-idconsultafilter-id)
  - [`GET /obtemConfigFiles`](#get-obtemconfigfiles)
  - [`GET /termos-trad`](#get-termos-trad)
  - [`GET /informativos`](#get-informativos)
  - [`GET /busca-por-placa`](#get-busca-por-placa)
  - [`POST /fale-conosco`](#post-fale-conosco)
  - [`GET /catweb/v2/getpol.asp`](#get-catwebv2getpolasp)
- [Filter ID reference](#filter-id-reference)
- [Product field reference](#product-field-reference)
- [Images and files](#images-and-files)
- [Errors](#errors)
- [Pagination](#pagination)
- [Not reachable from outside](#not-reachable-from-outside)
- [Before you use this](#before-you-use-this)

---

## Quick start

`tecfil_api.py` in this repo is a dependency-free client that handles the filter encoding and
the response decoding. First call, start to finish:

```python
import tecfil_api as t

r = t.consulta({}, tipo_retorno="PRODUTO", ordenacao="produtos", limit=3, idm="en")
print(r["totalResultado"])                       # "2539"
print([p["NumeroProduto"] for p in r["data"]])   # ['ACA004', 'ACA005', 'ACA104']
```

The equivalent raw request:

```bash
curl -s "https://catalogoexpresso.com.br/ideia2001/api/v2/consulta?chavePerfil=8e8539e2-7a58-493e-9eb8-e3ebba1f93de&idConsulta=PESQUISA&tabAtiva=0&tipoRetorno=PRODUTO&ordenacao=produtos&filtros=&limit=3&offset=0&idm=en"
```

That returns a base64 blob, not JSON. See [Response encoding](#response-encoding).

---

## Hosts

| Host | Role | Directly usable |
|---|---|---|
| `catalogoexpresso.com.br/ideia2001/api/v2` | The data API. Everything in this doc unless noted. | Yes |
| `ideia2001.com.br` | Legacy ASP endpoints: consent banner, bulletin files, bulk photo download. | Yes |
| `www.c123.com.br` | Static product-photo CDN. | Yes |
| `catexpapi.ideia2001.com.br` | Customer pricing/parameter service. | No — server-side secret |
| `catalogo.tecfil.com.br` | Next.js front end. Serves HTML; holds one internal cache route. | HTML only |

Throughout this doc, **base URL** means `https://catalogoexpresso.com.br/ideia2001/api/v2`.

---

## Authentication

There is none. No API key, no bearer token, no cookie, no CORS restriction on the endpoints
below.

Two parameters act as tenant identity rather than credentials, and both are published in the
page source of every request to the public site:

| Parameter | Tecfil value | Meaning |
|---|---|---|
| `chavePerfil` | `8e8539e2-7a58-493e-9eb8-e3ebba1f93de` | Selects the catalogue. Required on every call. |
| `codigoCatalogo` | `133` | Used in image paths and cache tags, not in API query strings. |

Two endpoints are gated by **reCAPTCHA v2 invisible**, passed as an `x-recaptcha-v2-token`
header: [`/busca-por-placa`](#get-busca-por-placa) and [`/fale-conosco`](#post-fale-conosco).
Site key `6LcW1LsrAAAAAIVp4zfw6bpKNBPBNYU-1iBhLE6l`.

### Language

`idm` accepts `pt` (default), `en`, `es`. It translates **data**, not just UI chrome —
`DescricaoProduto` `"Ar Cabine"` becomes `"Cabin Air"`, `Observacao` `"SUBSTITUÍDO PELO
ACP004."` becomes `"REPLACED BY ACP004."`, and group names change (`"FILTROS"` → `"FILTERS"`).

**If you filter on a label, the label must match the `idm` you send.** Filtering
`GRUPOPRODUTO` on `"FILTERS"` with `idm=pt` will not match. Filtering by `Codigo` avoids
the problem entirely.

---

## Response encoding

`/consulta`, `/obtemConfigFiles`, `/termos-trad` and `/informativos` return
`Content-Type: text/html` containing an opaque base64 blob. This is scrambling, not
encryption — no key is involved and the routine ships in the public bundle.

To decode:

1. Base64-decode the body, read as UTF-8.
2. Split on `<!1!>`. You get three parts.
3. Parts `0` and `2` are JSON arrays of integers. Part `1` is the scrambled payload.
4. Rotate part 1 with array 2, then rotate that result with array 0. Each rotation walks its
   array in reverse; for offset `n`, move the last `n` characters to the front.
5. Base64-decode the result, read as UTF-8. That is the JSON.

```python
import base64, json

def _rot(s, offsets):
    for n in reversed(offsets):
        i = len(s) - n
        s = s[i:] + s[:i]
    return s

def decode(body):
    p = body.strip()
    if p.startswith("{") or p.startswith("["):   # errors bypass the wrapper
        return json.loads(p)
    parts = base64.b64decode(body).decode("utf-8").split("<!1!>")
    t = _rot(parts[1], json.loads(parts[2]))
    t = _rot(t, json.loads(parts[0]))
    return json.loads(base64.b64decode(t).decode("utf-8"))
```

Error responses skip the wrapper and arrive as plain JSON. Always pass a body starting with
`{` or `[` straight through — the site's own decoder does exactly this.

`/catweb/v2/getpol.asp` returns plain JSON and is never wrapped.

---

## The `filtros` grammar

`filtros` is not JSON. It is a flat string joined by four sentinel tokens, then URL-encoded
as one query parameter.

| Token | Role |
|---|---|
| `<!1!>` | Separates one filter from the next |
| `<!2!>` | Separates a filter ID from its value |
| `<!4!>` | Separates *from* and *to* inside a range value |
| `<!5!>` | Prefix that negates a filter |

Two construction rules:

**1. A filter carrying a code emits two entries** — the label under its own ID, and the code
under `cod` + that ID.

```
FABRICANTEAPLICACAO<!2!>VOLKSWAGEN<!1!>codFABRICANTEAPLICACAO<!2!>36
```

**2. Range filters collapse before transmission.** The UI authors them as a
`DE-<FIELD>` / `ATE-<FIELD>` pair; the wire format is a single `<FIELD>` whose value is
`from<!4!>to`.

```
DE-CPOAUXPROD28 = 100  +  ATE-CPOAUXPROD28 = 200
        →   CPOAUXPROD28<!2!>100<!4!>200          # 698 of 2539 products
            CPOAUXPROD28<!2!><!4!>100             # 1086 — open lower bound
```

> **Gotcha:** sending `DE-CPOAUXPROD28` verbatim returns all 2,539 rows with `200 OK`. No
> error, no warning. A range filter that appears to do nothing is almost always this.

Combined example — Volkswagen, model year 2020:

```
FABRICANTEAPLICACAO<!2!>VOLKSWAGEN<!1!>codFABRICANTEAPLICACAO<!2!>36<!1!>AplicacaoAnoDeAte<!2!>2020
```

URL-encoded, that is:

```
FABRICANTEAPLICACAO%3C%212%21%3EVOLKSWAGEN%3C%211%21%3EcodFABRICANTEAPLICACAO%3C%212%21%3E36%3C%211%21%3EAplicacaoAnoDeAte%3C%212%21%3E2020
```

---

## Endpoints

### `GET /consulta` — search (`idConsulta=PESQUISA`)

The main endpoint. Paged, filtered catalogue search.

**Request**

| Parameter | Type | Required | Description |
|---|---|:--:|---|
| `chavePerfil` | uuid | ✓ | Tenant key |
| `idConsulta` | `PESQUISA` | ✓ | Selects search mode |
| `tabAtiva` | int | ✓ | Result tab index. This catalogue defines one tab: `0` |
| `tipoRetorno` | enum | ✓ | `PRODUTO` \| `APLICACAO` \| `REFERENCIA` — sets the row schema |
| `ordenacao` | enum | ✓ | May be empty. See defaults below |
| `filtros` | string | ✓ | Encoded filters; `""` for unfiltered |
| `limit` | int | ✓ | Rows per page. The site uses `30` |
| `offset` | int | ✓ | Absolute row offset, not a page number |
| `idm` | enum | | `pt` (default) \| `en` \| `es` |
| `filtrosSecundarios` | string | | Same grammar as `filtros`; the sidebar refinements |
| `buscaExata` | string | | Truthy value enables exact-match |
| `codigoAnonimo` | string | | Anonymous visitor id |
| `debug` | string | | Passed through to the ASP backend |

`ordenacao` values: `produtos`, `filtros`, `conversoes`, `fabricante-aplicacao`,
`descricao-produto`. Defaults used by the site: `PRODUTO` → `produtos`,
`APLICACAO` → `filtros`, `REFERENCIA` → `conversoes`.

**Response envelope** (identical for all three `tipoRetorno` values)

```json
{
  "success": true,
  "data": [ ... ],
  "totalResultado": "2539",
  "quantidadeDetalhada": [
    { "Descricao": "Specifications", "Tipo": "Especificacoes", "Quantidade": 2539 },
    { "Descricao": "Conversions",    "Tipo": "Conversoes",     "Quantidade": 36872 },
    { "Descricao": "Total",          "Tipo": "Total",          "Quantidade": 13584 },
    { "Codigo": 1, "Descricao": "Cars",   "Tipo": "TipoAplicacao", "Quantidade": 3887 },
    { "Codigo": 4, "Descricao": "Trucks", "Tipo": "TipoAplicacao", "Quantidade": 1855 }
  ]
}
```

`totalResultado` is a **string**. `quantidadeDetalhada` is the facet strip: three summary rows
(`Especificacoes`, `Conversoes`, `Total`) plus one row per application type, `Codigo` 1–7 —
Cars, Motorcycles, Buses, Trucks, Harvesters, Machines and Equipment, Tractors. The counts
respect the active filters, so this doubles as a cheap faceting call at `limit=1`.

<details>
<summary><b><code>data</code> row — <code>tipoRetorno=PRODUTO</code></b></summary>

One row per part.

```json
{
  "CodigoProduto": 796,
  "NumeroProduto": "ACA004",
  "DescricaoProduto": "Cabin Air",
  "Unidade": "",
  "CodigoGrupoProduto": 1,
  "Observacao": "REPLACED BY ACP004.",
  "FlagLancamento": 0,   "DataFlagLancamento": "",
  "FlagPromocao": 1,     "DataFlagPromocao": "",
  "FlagPontaEstoque": 0, "DataFlagPontaEstoque": "",
  "ArquivoFotoProduto": "ACA004_A.jpg",
  "ArquivoFotoProduto2": "",
  "ArquivoFotoProduto3": "",
  "CpoAuxProd3": "32",
  "CpoAuxProd8": "32 x 210 x 240 x Não",
  "CpoAuxProd19": "Activated Carbon",
  "CpoAuxProd28": "32", "CpoAuxProd29": "240", "CpoAuxProd30": "210",
  "CpoAuxProd42": "0,225", "CpoAuxProd43": "0,165",
  "ReferenciasCruzada": [
    { "DescricaoFabricante": "MANN", "NumerosProduto": [{ "NumeroProduto": "CU2143/1" }] },
    { "DescricaoFabricante": "WEGA", "NumerosProduto": [{ "NumeroProduto": "AKX35722/C" }] }
  ]
}
```

`CpoAuxProd1`–`CpoAuxProd55` are the catalogue's user-defined spec columns and are sparse —
see [Product field reference](#product-field-reference). `CodigoProduto` is the id used by the
site's own URLs (`/en/produto/796`) and by
[product detail](#get-consulta--product-detail-idconsultapesquisa_detalhes).
</details>

<details>
<summary><b><code>data</code> row — <code>tipoRetorno=APLICACAO</code></b></summary>

One row per vehicle fitment.

```json
{
  "DescricaoFabricante": "VOLKSWAGEN",
  "CodigoAplicacao": 198328,
  "DescricaoAplicacao": "10160",
  "ComplementoAplicacao3_1": "Euro 5",
  "ComplementoAplicacao3_2": "Cummins ISF 160",
  "ComplementoAplicacao3_3": "2012",
  "ComplementoAplicacao3_4": ">",
  "ComplementoAplicacao3_5": "Diesel",
  "ComplementoAplicacao3_9":  [{ "CodigoProduto": 128, "TituloProduto": "AP7998",  "CpoAuxProd53": "Sim" }],
  "ComplementoAplicacao3_10": [{ "CodigoProduto": 135, "TituloProduto": "PSL...",  "CpoAuxProd53": "" }]
}
```

`ComplementoAplicacao3_1`–`3_5` are emission standard, engine, start year, end-year marker and
fuel. From `3_9` upward, each key is an **array of fitted parts for one catalogue column** —
this is what builds the result grid's Cabin Air / Motor / Air 1 / Air 2 / Lubricant columns.
The column-to-key mapping lives in `tecfil-catalog-config.json` under
`listaResultado.tabelaAplicacao.colunas`.
</details>

<details>
<summary><b><code>data</code> row — <code>tipoRetorno=REFERENCIA</code></b></summary>

One row per cross-reference (a competitor part number that maps to a Tecfil part).

```json
{
  "CodigoProduto": 347,
  "DescricaoProduto": "Lubrificante",
  "NumeroProdutoTecFil": "PSL339",
  "DescricaoFabricanteReferencia": "ZF",
  "NumeroProdutoReferencia": "0070131265",
  "FlagLancamento": 0, "FlagPromocao": 0, "FlagPontaEstoque": 0
}
```
</details>

**Examples**

```python
import tecfil_api as t

# free-text search across description, application and code
t.consulta({"PCs": {"Descricao": "oleo"}},
           tipo_retorno="PRODUTO", ordenacao="produtos", limit=30)
# → totalResultado "8"

# every Volkswagen application from 2020
t.consulta({"FABRICANTEAPLICACAO": {"Descricao": "VOLKSWAGEN", "Codigo": 36},
            "AplicacaoAnoDeAte":   {"Descricao": "2020"}},
           tipo_retorno="APLICACAO", ordenacao="filtros", idm="en", limit=30)
# → totalResultado "257"   (643 without the year)

# cross-references for one part number
t.consulta({"NumeroProdutoOuReferencia": {"Descricao": "PSL339"}},
           tipo_retorno="REFERENCIA", ordenacao="conversoes", limit=30)

# facet counts only
t.consulta({"GRUPOPRODUTO": {"Descricao": "FILTERS", "Codigo": 1}},
           tipo_retorno="PRODUTO", ordenacao="produtos", limit=1, idm="en"
           )["quantidadeDetalhada"]
```

---

### `GET /consulta` — product detail (`idConsulta=PESQUISA_DETALHES`)

Full record for a single product. The product page uses this.

**Request** — as for search, with these differences:

| Parameter | Notes |
|---|---|
| `idConsulta` | `PESQUISA_DETALHES` |
| `filtros` | Must contain `CodigoProduto<!2!><id>` |
| `ordenacao`, `offset` | Not sent |
| `tipoRetorno` | `PRODUTO` for the full record, `APLICACAO` for its fitment list |
| `limit` | Caps the nested applications. Omit or raise it to load them all |

**Response** — the standard envelope; `data` holds one product with the complete
`CpoAuxProd` block, all three photo filenames, `ReferenciasCruzada`, and its applications
nested inside.

```python
t.consulta(tipo_retorno="PRODUTO", id_consulta="PESQUISA_DETALHES",
           codigo_produto=339, limit=1, idm="en")
# → AP9834 · "Heavy Air" · 376 x 196,8 x 105 - 8,5
```

The site's "more applications" control is the same call reissued with a larger `limit`.

---

### `GET /consulta` — filter options (`idConsulta=<filter ID>`)

Distinct values for one filter. This is how every dropdown populates, and the **only**
`/consulta` variant the browser calls client-side.

**Request**

| Parameter | Required | Description |
|---|:--:|---|
| `chavePerfil` | ✓ | |
| `idConsulta` | ✓ | Any value from the [filter ID reference](#filter-id-reference) |
| `tabAtiva` | ✓ | `0` |
| `filtros` | ✓ | Already-selected filters, to cascade. `""` for all values |
| `idm` | | Translates the returned labels |

**Response** — a bare list. No `totalResultado`, no facets.

```json
{ "success": true,
  "data": [ { "Codigo": 39, "Descricao": "ADAMS" },
            { "Codigo": 40, "Descricao": "AGCO" } ] }
```

Some filters return `Descricao` only, with no `Codigo`.

**Cascading**

```python
# all vehicles: 8894
t.get("/consulta", {"chavePerfil": t.CHAVE_PERFIL, "idConsulta": "APLICACAO",
                    "tabAtiva": "0", "idm": "en", "filtros": ""})

# vehicles for one manufacturer: 241
t.get("/consulta", {"chavePerfil": t.CHAVE_PERFIL, "idConsulta": "APLICACAO",
                    "tabAtiva": "0", "idm": "en",
                    "filtros": t.encode_filtros(
                        {"FABRICANTEAPLICACAO": {"Descricao": "VOLKSWAGEN", "Codigo": 36}})})
```

> **Gotcha:** a label paired with the wrong `Codigo` returns `502 "Resposta inválida do ASP"`,
> not an empty list. Always take the pair from a prior options call.

---

### `GET /obtemConfigFiles`

Configuration for one front-end component.

**Request:** `chavePerfil` ✓, `idComponente` ✓, `idm`.

**Response:** the component's config object.

```bash
curl ".../obtemConfigFiles?chavePerfil=$KEY&idComponente=MultiIdioma"
# → {"idiomaDefault": "pt", "idiomas": ["pt", "en", "es"]}
```

Other component names appear in the tenant config; only `MultiIdioma` is verified here.

---

### `GET /termos-trad`

The catalogue's data-vocabulary glossary. The front end uses it to localise values the API
returns untranslated.

**Request:** `chavePerfil` ✓.

**Response:** ~29 KB of Portuguese / Spanish / English triples.

```json
{ "termosTrad": [
    { "TermoP": "Rosca",        "TermoE": "Rosca",        "TermoI": "Thread" },
    { "TermoP": "Ano Inicial",  "TermoE": "Año Inicial",  "TermoI": "Start Year" }
] }
```

---

### `GET /informativos`

Technical bulletins.

**Request:** `chavePerfil` ✓, `idioma`, and optionally `filtroCategoria`,
`codigoInformativo`, `numeroInformativo`.

**Response:** ~300 KB.

```json
{ "informativos": [
    { "TituloInformativo": "KTU004",
      "TipoInformativo": "IMG",
      "CategoriaInformativo": "",
      "LinkInformativo": "https://www.ideia2001.com.br/CatWeb/v2/RetornaArquivo.asp?b64=0&retcont=1&ce=133&arq=Informativos/I/794.img",
      "NumeroInformativo": "717/26",
      "DataInformativo": "2026-08-12T00:00:00" }
] }
```

---

### `GET /busca-por-placa`

Brazilian licence-plate → vehicle lookup. **Gated by reCAPTCHA.**

**Request:** `chavePerfil` *or* `codigoEmpresa` ✓, `placa` ✓ (7 characters), optional
`codigoCliente`, `idioma`, `codigoAnonimo`, `debug`. Header `x-recaptcha-v2-token` required.

**Response** without a token — plain JSON, not wrapped:

```json
{ "message": "Token reCAPTCHA não fornecido", "error": "Bad Request", "statusCode": 400 }
```

The success shape is unverified; the captcha was not solved.

---

### `POST /fale-conosco`

Contact form. **Gated by reCAPTCHA.** Documented from the client bundle; not exercised.

**Request**

```http
POST /ideia2001/api/v2/fale-conosco
Content-Type: application/json
x-recaptcha-v2-token: <token>

{ "chavePerfil": "...", "nome": "", "empresa": "", "email": "", "telefone": "", "mensagem": "" }
```

**Response:** the client checks only `response.ok`.

---

### `GET /catweb/v2/getpol.asp`

LGPD consent banner text. **Different host:** `https://ideia2001.com.br`. Returns plain JSON,
never wrapped.

**Request:** `chavePerfil` *or* `codigoEmpresa` ✓, `idm`.

```json
{ "politicaAtivada": true,
  "textoTarja": "By continuing to browse the Catalog, you agree to our <a href=\"https://ideia2001.com.br/catweb/PoliticaPrivacidade.asp?e=...&i=i\" target=\"_blank\">Privacy Policy</a>.",
  "textoBotao": "Close" }
```

---

## Filter ID reference

Every ID below works **both** as a `filtros` key and as an `idConsulta` value to enumerate
its options. Counts are unfiltered, `idm=en`, as of 2026-09-03.

| Filter ID | UI control | Kind | Options | Has `Codigo` |
|---|---|---|--:|:--:|
| `PCs` | General search box | free text | — | — |
| `NumeroProdutoOuReferencia` | Tecfil code / conversion no. | free text | — | — |
| `GRUPOPRODUTO` | Group | select | 2 | ✓ |
| `SUBGRUPOPRODUTO` | Subgroup | select | 0 | ✓ |
| `TIPOAPLICACAO` | Application type / segment icons | select | 7 | ✓ |
| `FABRICANTEAPLICACAO` | Manufacturer | select | 199 | ✓ |
| `APLICACAO` | Vehicle | select | 8894 | ✓ |
| `ComplementoAplicacao3_2` | Engine | select | 3680 | |
| `AplicacaoAnoDeAte` | Year | select | 69 | |
| `DescricaoProduto` | Product | select | 36 | ✓ |
| `DE-` / `ATE-CPOAUXPROD28` | Height, mm | range | — | |
| `DE-` / `ATE-CPOAUXPROD29` | External ⌀, mm | range | — | |
| `DE-` / `ATE-CPOAUXPROD30` | Internal ⌀, mm | range | — | |
| `CPOAUXPROD35` | Thread | select | 97 | |
| `CPOAUXPROD53` / `CPOAUXPROD54` | MaxPro badges | select | 1 each | |
| `FlagLancamento` | New releases | flag `1` | 38 hits | |
| `FlagPromocao` | In development | flag `1` | — | |
| `FlagPontaEstoque` | Discontinued | flag `1` | — | |
| `CodigoProduto` | — | internal, for detail lookup | — | |

`AplicacaoAnoDeAte` is a **single-value select**, not a range — pass one year.

---

## Product field reference

`CpoAuxProdN` are user-defined columns; their meaning is per-tenant. For catalogue 133:

| Field | Meaning |
|---|---|
| `CpoAuxProd2`, `CpoAuxProd9` | EAN / barcode |
| `CpoAuxProd3`, `CpoAuxProd28` | Height, mm |
| `CpoAuxProd29` | External diameter, mm |
| `CpoAuxProd30` | Internal diameter, mm |
| `CpoAuxProd35` | Thread |
| `CpoAuxProd19` | Filter media |
| `CpoAuxProd10` / `15` / `16` | Product name in pt / es / en |
| `CpoAuxProd8`, `CpoAuxProd55` | Assembled dimension string |
| `CpoAuxProd42`, `CpoAuxProd43` | Weights, kg |
| `CpoAuxProd24`, `25`, `53`, `54` | Yes/no badges (`53`/`54` drive the MaxPro marks) |
| `CpoAuxProd47` | Group code |

The authoritative column-to-label mapping for this tenant is in
`tecfil-catalog-config.json` (`detalhesProduto` and `listaResultado`).

---

## Images and files

Photo filenames arrive in `ArquivoFotoProduto`, `…2`, `…3` and resolve against a static path
built from `codigoCatalogo`:

```
https://www.c123.com.br/CatalogoExpresso/133/FotoProdWeb/AP9834_A.jpg        # full size
https://www.c123.com.br/CatalogoExpresso/133/FotoProdWeb/dcp/AP9834_A.jpg    # display copy
```

| Resource | URL |
|---|---|
| Bulletin files | `ideia2001.com.br/CatWeb/v2/RetornaArquivo.asp?b64=0&retcont=1&ce=133&arq=...` |
| Bulk photo download | `ideia2001.com.br/catalogoexpresso/462/arqsfotos_yutt1/getfotos.asp` |
| Privacy policy | `ideia2001.com.br/catweb/PoliticaPrivacidade.asp?e=...&i=i` |

---

## Errors

Error responses are **plain JSON** and skip the obfuscation wrapper.

```json
{ "message": "...", "error": "Bad Request", "statusCode": 400 }
```

| Status | `message` | Cause | Fix |
|---|---|---|---|
| `400` | `Token reCAPTCHA não fornecido` | Captcha-gated endpoint called without the header | Not solvable programmatically |
| `502` | `Resposta inválida do ASP` | Label/code mismatch in `filtros` — **or transient backend flakiness** | Take label+code from an options call; retry once before treating it as a bad request |

**Silent failures** — these return `200 OK` with wrong results, so watch for them:

- A `DE-`/`ATE-` range sent uncollapsed is **ignored**; you get the unfiltered set.
- A label that does not match the `idm` you sent matches nothing.

The `502` is genuinely intermittent: an identical request that failed during this mapping
succeeded on retry a second later. Build in one retry.

---

## Pagination

`limit` + `offset`, where **`offset` is an absolute row count, not a page number**.
`totalResultado` (a string) gives the bound.

```python
total = int(t.consulta({}, tipo_retorno="PRODUTO", ordenacao="produtos",
                       limit=1, idm="en")["totalResultado"])

for offset in range(0, total, 30):
    page = t.consulta({}, tipo_retorno="PRODUTO", ordenacao="produtos",
                      limit=30, offset=offset, idm="en")
    ...
```

Ordering is stable within a fixed `ordenacao`. There is no cursor and no `ETag`. No rate limit
is documented or advertised — see below.

---

## Not reachable from outside

These appear in the client bundle but are not usable as a data source.

| Endpoint | Why |
|---|---|
| `POST catalogo.tecfil.com.br/api/revalidate_cache` | Next.js cache-purge route. Needs the server-side `AUTHORIZATION_REVALIDATE_CACHE` secret, and it mutates rather than reads. |
| `POST catexpapi.ideia2001.com.br/CodPersOnline/133/BuscarParametro` | Customer-specific pricing/parameter service. Needs `CODPERS_API_AUTHORIZATION`, a server env var absent from the bundle. Body: `{criterioChave, retornaDefault}`. |
| `cdn.builder.io/api/v3/content` | Builder.io CMS holding page layout and UI copy, not catalogue data. Public via `apiKey=<key>` if you need the config tree. |

---

## Before you use this

The API is unauthenticated, but it is **not published as a public API**. There are no
documented rate limits, no terms covering programmatic use, and the `502` behaviour suggests
a fragile ASP backend behind the JSON layer.

If you are building on this:

- **Throttle and cache.** The front end caches with a 600-second revalidation window; match
  that at minimum. The full catalogue is ~85 paged calls at `limit=30`.
- **Retry once on `502`**, then back off.
- **Pin nothing to the counts in this document.** They are live figures from 2026-09-03 and
  will drift.
- **Ask first.** For anything sustained, contact Tecfil or Ideia2001 rather than assuming
  open access implies permission.

---

*Reverse-engineered from the live site and its client bundles, 2026-09-03. Unofficial and
unaffiliated. Client implementation: `tecfil_api.py`. Tenant config dump:
`tecfil-catalog-config.json`.*
