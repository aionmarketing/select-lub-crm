/**
 * The six authenticated screens, shared by every navigation variant.
 *
 * The list lives here rather than inside a nav component because it is not a
 * composition concern: the `cursor` variant draws it as the artboard's
 * horizontal row and the `antigravity` variant as a vertical icon rail, but
 * "all six, every time, in this order" must be one fact, not two. Three pages
 * had already drifted apart before the row was extracted — Relatórios listed
 * four screens plus the Galeria QA page, while Configurações and Usuários each
 * omitted Relatórios — and a second nav component is exactly the occasion for
 * that to happen again.
 */

/**
 * The six MVP screens, in the order the canvas draws them.
 *
 * `/galeria` is deliberately absent: it is a token-preview page for visual QA,
 * not a product screen, and the artboards show six entries. The route stays
 * reachable by URL.
 */
export const SCREENS = [
  { to: "/", label: "Conversas" },
  { to: "/servicos", label: "Serviços" },
  { to: "/follow-up", label: "Follow-up" },
  { to: "/relatorios", label: "Relatórios" },
  { to: "/configuracoes", label: "Configurações" },
  { to: "/usuarios", label: "Usuários" },
] as const;
