/**
 * Contract fixtures for conversations' tag and template shapes, for tests (here and in `apps/web`).
 *
 * Moved from `packages/shared-types/src/fixtures.ts` (5.1d) with declarations unchanged.
 */
import type { Tag } from "./http.tag.js";
import type { Template } from "./http.template.js";

// Copied from quotes' http.fixtures.ts when 5.1d split the old shared fixtures file by module:
// a private helper, so each fixtures file carries its own.
const timestamps = {
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

/** Sample inactive tag for list-filter and sort-order tests. */
export const tagFixture = {
  id: "tag-1",
  name: "Orçamento",
  color: null,
  sortOrder: 0,
  active: false,
} satisfies Tag;

/** Sample template with both allowed placeholders for preview substitution tests. */
export const templateFixture = {
  id: "tpl-1",
  name: "Confirmação de orçamento",
  text: "Olá {{nome_cliente}}, o orçamento do veículo {{placa}} está pronto.",
  allowedVariables: ["nome_cliente", "placa"],
  status: "active",
  ...timestamps,
} satisfies Template;
