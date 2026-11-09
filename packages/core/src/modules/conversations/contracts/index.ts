/**
 * The conversations module's public surface: what another module, or an app,
 * may call. Reached from outside the package as
 * `@select-lub/core/modules/conversations/contracts`.
 *
 * - `setCustomer` / `getCadastroLink` — for `customers` (4B) and prefill (4C).
 * - `setExtractEnabled` / `closePrefillWindow` — for prefill (4C).
 * - `messageReceived` — the event prefill's `enqueue-prefill` subscribes to (4C).
 * - `http.ts` — the web contract, over this folder's `http.<topic>.ts` files (5.1d).
 */
export { getCadastroLink, type CadastroLink } from "./get-cadastro-link.js";
export { setCustomer, type SetCustomerInput, type SetCustomerResult } from "./set-customer.js";
export { closePrefillWindow, setExtractEnabled } from "./set-extract-enabled.js";
export { messageReceived, messageReceivedSchema, type MessageReceived } from "./message-received.js";
export * from "./http.js";
