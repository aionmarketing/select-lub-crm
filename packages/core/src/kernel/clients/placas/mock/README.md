# mock

Canned plate → vehicle rows for `PLACAS_MOCK=1`. Never billed; never written to the lookup cache.

- **dataset.ts** — several plates, plus rows with absent `versao`, absent `modeloDetalhes`, and placeholder values
- **source.ts** — `createMockPlateProvider()` looks up a normalized plate and maps through the same `agregados-propria` mapper
