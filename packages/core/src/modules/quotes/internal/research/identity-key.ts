/**
 * The identity key research is keyed by (background-oil-research D6, task 2.2).
 *
 * `<year>|<normalizeMotulName(make)>|<normalizeMotulName(model)>|<normalizeMotulName(version)>` —
 * the same normalization the caches match with (`motulIdentitiesMatch`), so one key serves
 * exactly the rows the caches would serve.
 *
 * Shipped in PR 1; since PR 4 it lives in the module's public scope
 * (`contracts/oil-research-attention.ts`), because `readActiveOilResearch` keys the rail's
 * vehicles by it for customers. Re-exported here so the runner's internals keep one import path.
 */
export { identityKey, type IdentityFields } from "../../contracts/oil-research-attention.js";
