# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/select-lub-crm/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.
>
> Visual tokens come from `AGENTS.md` and `apps/web/src/theme.ts`.
> ui-ux-pro-max supplies accessibility, touch, forms, and motion rules.
> It does **not** replace the brand palette, typeface, or approved canvas.

---

**Project:** Select Lub CRM
**Updated:** 2026-09-08
**Product:** Internal workshop CRM (WhatsApp inbox, cadastro, orçamento, follow-up, reports)
**Stack:** React + Vite + MUI (Material 3)
**Design dials:** Variance 4/10 (balanced) · Motion 3/10 (subtle) · Density 8/10 (dashboard)

---

## Source of truth

| Layer                                                       | Wins                                                |
| ----------------------------------------------------------- | --------------------------------------------------- |
| Colour, typeface, radii, spacing scale, button shape        | `AGENTS.md` → `createAppTheme` in `theme.ts`        |
| Screen layout and hierarchy                                 | Approved artboards in `design/mvp-screen-designs/`  |
| Accessibility, keyboard, labels, touch size, reduced motion | ui-ux-pro-max UX rules, applied on top of the brand |

### Rejected auto-match (do not apply)

A raw `--design-system` query for “automotive” returned slate/red, Syncopate + Space Mono, Motion-Driven style, and a Hero-Centric landing pattern. Those contradict the Select Lub brand and this product (an authenticated CRM, not a marketing site). Do not persist or implement them.

---

## Color palette

Two **light** palettes, same token names, selected by the header switch and stored in `localStorage` key `select-lub.palette`. Hexes live only in `theme.ts`. Never paste hex into components.

### `yellow-cta` (default)

| Role                 | Hex       | Usage                                                                    |
| -------------------- | --------- | ------------------------------------------------------------------------ |
| Primary              | `#EAB63D` | Contained CTA **fill** only. Never as text or icon on white (~1.9:1).    |
| On Primary           | `#111111` | Label on primary                                                         |
| Primary Container    | `#FFF3C4` | Selected rows, chips, outbound emphasis                                  |
| On Primary Container | `#111111` | Text on primaryContainer                                                 |
| Secondary            | `#303030` | Header/hero, dark buttons; also the yellow-cta text/outlined/link colour |
| On Secondary         | `#FFFFFF` | Text on secondary                                                        |

### `black-cta`

| Role                 | Hex       | Usage                            |
| -------------------- | --------- | -------------------------------- |
| Primary              | `#303030` | Contained CTA fill (label white) |
| On Primary           | `#FFFFFF` | Label on primary                 |
| Primary Container    | `#EAB63D` | Selected rows / chips            |
| On Primary Container | `#111111` | Text on primaryContainer         |
| Secondary            | `#111111` | Dark emphasis                    |
| On Secondary         | `#FFFFFF` | Text on secondary                |

### Shared

| Role            | Hex       | Usage                                         |
| --------------- | --------- | --------------------------------------------- |
| Surface         | `#FFFFFF` | Page/card (Conversas, shell, login)           |
| Surface Variant | `#EDEDED` | Grey ground under PageShell screens           |
| On Surface      | `#111111` | Body text                                     |
| Outline         | `#D9D9D9` | Borders, dividers                             |
| Error           | `#B3261E` | Validation / Alert error (M3 default)         |
| WhatsApp        | `#25D366` | Send-via-WhatsApp only. Never `success.main`. |
| Read tick       | `#1565C0` | Message-status ticks                          |

Text contrast on surfaces: **4.5:1** minimum (WCAG AA). Gold is a fill. Keyboard focus ring is **2px** `secondary.main` with 2px offset (charcoal on both palettes).

---

## Typography

- **UI typeface:** Inter (`@fontsource/inter`), never a Google Fonts CDN.
- **Scale** (`TYPE_SCALE` in `theme.ts`): page 26 / section 18 / subsection 15 / body 13 / caption **12** / metric 30.
- Canvas artboards still write caption as 11px. **Product UI must not go below 12px** (ui-ux-pro-max + WCAG). That 1px lift is a declared deviation.
- Body line-height 1.5. Page title is the screen’s only `h1`.
- Button labels keep written case (`textTransform: "none"`).

---

## Spacing, radii, motion

Spacing is MUI’s 8px base with half-steps: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Do not set `spacing: 4` on the theme.

Radii: inputs/chips 4px, cards 8px, buttons and dialogs 16px (pills).

Motion: 150–300ms on colour/border/shadow only. No layout-shifting hover (`scale`/`translateY` on cards). `prefers-reduced-motion: reduce` disables those transitions. Anchor scroll is `smooth`, and `auto` when reduced motion is requested.

Minimum control target: **44×44 CSS px** (`TOUCH_TARGET_PX`). Dense `size="small"` text fields stay compact so filter rows do not grow. Icon-only controls inherit 44×44 even when the glyph is smaller.

---

## Layout

Authenticated chrome: 52px AppBar (`SHELL_BAR_HEIGHT_PX`) + six-entry `ScreenNav`. `html` `scroll-padding-top` is 52px so focus is not fully covered by the bar (WCAG 2.2 2.4.11).

A **skip link** (“Pular para o conteúdo”) is the first tab stop on authenticated screens and moves focus to `#conteudo-principal`.

- **PageShell screens** (Serviços is the split-pane exception; Relatórios, Follow-up, Configurações, Usuários): grey `surfaceVariant` main, borderless white cards (`cardSx`), section titles **above** cards, labels **above** inputs (`LabeledField`).
- **Conversas:** three-pane inbox (list / thread / rail) on white. Own `main`, not PageShell.

---

## Forms and feedback

- Visible label associated with the control (`label[for]` or `aria-labelledby`). Placeholder is an example, never the only name.
- Inline error under the field, linked with `aria-describedby` / `aria-invalid`. Keep a `role="alert"` summary at the top of the form and move focus there after a failed submit.
- Loading uses a skeleton plus a `role="status"` phrase, not a spinner-only void. Errors include a recovery action (“Tentar de novo”).
- `inputMode` / `type` match the value (phone → `tel` + `numeric`).

---

## Icons and controls

SVG only (inline or a single icon family). No emoji as structure. Decorative glyphs next to visible text are `aria-hidden`. Icon-only buttons have an accessible name and expose `aria-expanded` / `aria-pressed` when they toggle.

Clickable chips are buttons with `aria-pressed`, not clickable `div`s.

---

## Anti-patterns

- ❌ Raw hex in product components (theme only)
- ❌ Gold (`#EAB63D`) as text or icon on white
- ❌ WhatsApp green as `success`
- ❌ Placeholder-only labels
- ❌ Icon-only control without an accessible name
- ❌ Removing focus outlines
- ❌ Instant 0ms state changes (except under reduced motion)
- ❌ Emoji as icons
- ❌ Hero / marketing landing patterns on CRM screens
- ❌ Syncopate, Space Mono, or a red CTA palette

---

## Pre-delivery checklist (web CRM)

- [ ] No emoji as icons; decorative SVG is `aria-hidden`
- [ ] Icon-only controls named; toggles expose pressed/expanded
- [ ] Visible 2px focus ring on buttons, links, and focused inputs
- [ ] Skip link reaches `#conteudo-principal`; `scroll-padding-top` clears the AppBar
- [ ] Touch targets 44×44 except compact text fields
- [ ] Labels above fields; errors announced and linked to the field
- [ ] `prefers-reduced-motion` respected
- [ ] Body/caption contrast ≥ 4.5:1; gold never used as text
- [ ] Loading / empty / error / retry present on data surfaces
- [ ] No new hex in `apps/web/src` outside `theme.ts`
