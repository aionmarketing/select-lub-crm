/**
 * Conversations' HTTP contract: the request and response shapes its routes validate, and
 * the ones `apps/web` imports through `@select-lub/shared-types` (a barrel over
 * `@select-lub/core/contracts`).
 *
 * Defined here since 5.1d; before, they lived in `shared-types` and were re-exported here
 * (W2-C2). WEB-SAFE: every file this reaches imports only `zod`, other modules'
 * `contracts/http.ts` and `shared/web/` — per-file lint rules and
 * `packages/core/test/web-contracts.test.ts` hold that. Each name is exported by exactly
 * one module's http contract.
 */
export * from "./http.conversation.js";
export * from "./http.fixtures.js";
export * from "./http.follow-up.js";
export * from "./http.jid.js";
export * from "./http.should-reply.js";
export * from "./http.tag.js";
export * from "./http.template.js";
