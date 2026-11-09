# link-conversation-customer

**Purpose.** The rail's first save: find or create the conversation's customer, link the conversation to it, and apply the edit.

**Kind.** HTTP route, `POST /conversations/:id/customer`. Moved from `apps/api/src/cadastro/routes.ts` (adopt-modular-vertical-slices 4B) with the handler body unchanged but for where its dependencies come from.

**Tables written** (through the cadastro store (`contracts/cadastro-store`), one `db.tx("customers", …)` per call): `customer`, `customer_phone`, `vehicle` (a new WhatsApp cadastro), the edit's tables; `conversation.customer_id` through the conversations contract `setCustomer` (under `module_conversations`).

**Invariants.**
- 409 when the conversation already has a customer in the unit. A customer found by phone is linked, else a WhatsApp cadastro (customer + titular vehicle) is created.
- The edit then goes through `applyCrmEdit`, as `update-customer`, and publishes `customers/customer-changed`.

**Tests.** 2 cases in `route` (from `cadastro.test.ts`). Every case runs on the real database, the cadastro store under `module_customers`. The auth hook's cases are in `apps/api/test/customers.integration.test.ts`.
