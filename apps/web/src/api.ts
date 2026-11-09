/**
 * Typed HTTP client for the CRM API — attaches auth and unit headers from the session store.
 * Resource functions live in `./api/*.ts`; this file re-exports them.
 */
export * from "./api/auth.js";
export * from "./api/conversations.js";
export * from "./api/prefill.js";
export * from "./api/quote.js";
export * from "./api/reports.js";
export * from "./api/scheduled.js";
export * from "./api/send.js";
export * from "./api/services.js";
export * from "./api/tags.js";
export * from "./api/vehicles.js";
