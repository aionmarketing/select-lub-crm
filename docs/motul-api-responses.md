# Motul Oil Advisor API — Sample Responses

Live calls made on **2026-08-03** via `gateway-apim.motul.com/oil-advisor` (same backend used by `packages/motul`).

**Sample vehicle chain:** PEUGEOT → 2011 → 207 / Passion / SW → 1.4i 8V - TU3

---

## 1. `getVehicleBrands("CAR")`

**Endpoint:** `GET /vehicle-brands?categoryId=CAR&locale=pt-BR&BU=Brazil`

**Returns:** `VehicleBrand[]` — 51 brands total.

### Sample (first 5)

| name | id (truncated) | years |
|------|----------------|-------|
| CHEVROLET (GM) | `eyJpZCI6ImV5SnBaQ0k2TXpNMUxDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9` | 1976–2026 |
| FIAT | `eyJpZCI6ImV5SnBaQ0k2TWpjNUxDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9` | 1992–2026 |
| FORD | `eyJpZCI6ImV5SnBaQ0k2TWpnd0xDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9` | 1967–2026 |
| VOLKSWAGEN | `eyJpZCI6ImV5SnBaQ0k2TXpFeExDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9` | 1950–2026 |
| HONDA | `eyJpZCI6ImV5SnBaQ0k2TWpnMExDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9` | 1995–2026 |

### Selected for next step: PEUGEOT

```json
{
  "id": "eyJpZCI6ImV5SnBaQ0k2TXpBeExDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9",
  "name": "PEUGEOT",
  "years": ["2026", "2025", "…", "2011", "…", "1992"]
}
```

Each brand includes an opaque base64 `id` and a `years` array of valid model years.

---

## 2. `getVehicleModels(brandId, "2011")`

**Endpoint:** `GET /vehicle-models?vehicleBrandId={brandId}&year=2011&locale=pt-BR&BU=Brazil`

**Input:** PEUGEOT id + year `2011`

**Returns:** `VehicleModel[]` — 9 models.

```json
[
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnprMk5pd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "207 / Passion / SW" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJeE15d2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "3008" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJd05Dd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "307" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJd09Dd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "407" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJd09Td2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "408" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJeE5pd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "Boxer" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2T0RBMk5Td2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "Hoggar" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJeE55d2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "Partner" },
  { "id": "eyJpZCI6ImV5SnBaQ0k2TnpJeE9Dd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ", "name": "RCZ" }
]
```

### Selected for next step: 207 / Passion / SW

---

## 3. `getSubModels(modelId)`

**Endpoint:** `GET /vehicle-types?vehicleModelId={modelId}&locale=pt-BR&BU=Brazil`

**Input:** 207 / Passion / SW id

**Returns:** `SubModel[]` — 2 engine variants.

```json
[
  {
    "id": "eyJpZCI6ImV5SnBaQ0k2TVRJek9UY3NJbU1pT2lJeElpd2liU0k2TnprMk5pd2llU0k2SWpJd01URWlmUSIsInByb3ZpZGVySWQiOjF9",
    "name": "1.4i 8V - TU3"
  },
  {
    "id": "eyJpZCI6ImV5SnBaQ0k2TVRJek9UZ3NJbU1pT2lJeElpd2liU0k2TnprMk5pd2llU0k2SWpJd01URWlmUSIsInByb3ZpZGVySWQiOjF9",
    "name": "1.6 16V - TU5"
  }
]
```

### Selected for next step: 1.4i 8V - TU3

The `id` here is the `vehicleTypeId` passed to recommendations.

---

## 4. `getOilRecommendation(vehicleTypeId)`

**Endpoint:** `GET /recommendations?vehicleTypeId={vehicleTypeId}&locale=pt-BR&BU=Brazil`

**Input:** 1.4i 8V - TU3 id

**Returns:** `OilRecommendation` (unwrapped from `{ vehicle: … }`).

### Vehicle summary

```json
{
  "categoryId": "CAR",
  "brand": "",
  "type": "1.4i 8V - TU3",
  "model": "207 / Passion / SW",
  "startYear": "2011",
  "endYear": "2011"
}
```

### Components (2)

| category | capacity | recommended product (< 150k km) | upsell |
|----------|----------|-----------------------------------|--------|
| motor | 3,00 L | MOTUL 8100 X-CESS GEN2 5W-40 | MOTUL 300V COMPETITION 5W-40 |
| transmissão, manual - 5 marchas | 1,90 L | MOTUL MOTYLGEAR 75W-85 | — |

Each component has `recommendations` keyed by **usage** (`Normal`) and **mileage** (`-150 000km` / `+150 000km`). For this vehicle both mileage bands recommend the same products.

### Product shape (example — motor oil)

```json
{
  "name": "MOTUL 8100 X-CESS GEN2 5W-40",
  "emg": "17603",
  "apporder": "4",
  "recommendationCategory": {
    "title": "SPECIALIST",
    "description": "A melhor recomendação, de um especialista em lubrificantes, para alto desempenho."
  },
  "pictureUrl": "https://azupim01.motul.com/media/motulData/IM/bigweb/motul_109774_8100_x-cess_gen2_5w-40_1l_png_png.png",
  "details": {
    "normalizedData": {
      "aceaStandards": { "value": "ACEA A3/B4, API SERVICE SQ" },
      "approvals": { "value": "BMW LL-01, MERCEDES-BENZ MB-Approval 226.5, …" },
      "quantities": { "value": ["1L", "4L", "20L", "60L", "208L"] },
      "technicalDataSheetHref": { "value": "https://azupim01.motul.com/media/motulData/DO/base/8100_x-cess_g2_5w40_pt_pt_motul_20191202.pdf" }
    }
  }
}
```

`details` also includes full `variants` (SKU, EAN, viscosity), `gallery` images per SKU, and long HTML `description` fields — omitted here for brevity.

### Top-level conditions (mileage selector)

```json
{
  "mileage": [
    { "default": true,  "label": "-150 000km", "comments": [] },
    { "default": false, "label": "+150 000km", "comments": [] }
  ]
}
```

### `extraData.motulExpertLegends`

Footnote letters used in capacity/comment fields (e.g. `"a"` = "Somente para uso em veículos fora de garantia de fábrica.").

---

## ID chaining

```
getVehicleBrands("CAR")
  └─ brand.id
       └─ getVehicleModels(brand.id, year)
            └─ model.id
                 └─ getSubModels(model.id)
                      └─ subModel.id  (= vehicleTypeId)
                           └─ getOilRecommendation(subModel.id)
```

All IDs are opaque base64-encoded JSON tokens — pass them verbatim between calls.
