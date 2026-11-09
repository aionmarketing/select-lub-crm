# MVP screen designs — canvas source

Source files for the Claude Design canvas that is the normative visual
reference for the MVP screens (`openspec/specs/design-system/mvp-screen-designs/spec.md`).
Published canvas (the live, shareable page), a Design-type canvas since 2026-09-27:
https://claude.ai/artifact/WBSjSKKMhiJyhjLrsYTqWy

The earlier canvas, https://claude.ai/code/artifact/12761155-7592-4b52-99c7-355bff470766,
was an early-preview packaging that needs a `support.js` this repo does not carry.
It is kept untouched and no longer published to.

- `Main.dc.html` — Conversas (single navigable artboard: list, thread, rail,
  panels/dialogs).
- `Servicos.dc.html` — Serviços (`/servicos`): the unit's OS ledger as a list
  beside the selected service in detail.
- `Relatorios.dc.html` — Relatórios (`/relatorios`): filter bar, Follow-up
  alert strip, primary/secondary KPIs, CSS chevron funnel, origin table, and
  the remaining REP detail.
- `FollowUp.dc.html` — Follow-up (`/follow-up`): four operational sections with
  stat cards that anchor to them.
- `Configuracoes.dc.html`, `Usuarios.dc.html` — the other MVP screens.
- `canvas.json` — layout manifest (artboard positions, annotations).
- `check-artboards.mjs` — the mechanical checks described below.

All six artboards are published together as one canvas. Reviewing them side by
side is the point: the shared foundation has to read the same on every screen.

## The shared foundation

Each artboard carries a block fenced by `BEGIN/END SHARED FOUNDATION`
(CSS, in `<helmet><style>`) and `BEGIN/END SHARED FOUNDATION MARKUP`
(the app shell and page-nav row).

The **CSS block is byte-identical** across all six files. The **markup block is
identical in structure and content**, varying in exactly one way: which
`nav-item` carries `nav-item-on`.

No artboard wires a nav click (2026-09-01). Every confirmed screen now has its
own file, so a nav click could never reach its target — artboards share no
runtime. The nav row is a drawn representation of the app's navigation, and a
reviewer moves between screens by panning the canvas. `check-artboards.mjs`
fails an `onClick` inside the foundation markup rather than normalising it
away.

It holds the `yellow-cta` token table from `apps/web/src/theme.ts`, the
4/8/12/16/24/32/48/64 spacing scale, the 4/8/16px radii, and the type scale
(26 page / 18 section / 15 subsection / 13 body / 11 caption, plus a 30px step
for metric values).

One rule inside it is easy to get wrong: **gold (`#EAB63D`) is never a text or
icon colour.** It fails AA on white at roughly 1.9:1, which is why `theme.ts`
substitutes charcoal for `yellow-cta`'s text and outlined buttons and for
links. Gold is a fill — button backgrounds, the nav's current-item underline,
the palette selector's active option. Text that would read as "primary" uses
`--on-surface-accent` (`#303030`).

To change the foundation, edit one artboard's fenced block and copy it verbatim
into the other five, then run the checks. Never retype it. Copy bytes, not
lines: these files are LF, and a copy that lands CRLF fails the byte-identity
check with no visible difference.

## Checks

```
node design/mvp-screen-designs/check-artboards.mjs
```

Five things, all of which a rendered review can miss:

1. **Orphan bindings** — every `{{binding}}` resolves to a `data-props` key or
   a `renderVals()` path. This is not hypothetical: commit `7e278fb` removed
   `Relatorios.dc.html`'s entire `<script data-dc-script>` block while leaving
   its `{{screen.*}}` bindings in place, so loading, empty and error became
   unreachable. The artboard still looked right, because it rendered its
   `hint-placeholder-val` fallback — a reviewer cannot see a state that does
   not exist.
2. **Unwired handlers** — the mirror image, and equally invisible. No `go.*`
   handler may be defined without an `onClick` reaching it. Replacing Conversas'
   nav rows with the shared block dropped the two handlers wired into them and
   left the standalone Serviços screen with no way in and no way back, while
   every binding still resolved.
3. **Hardcoded literals** — no colour or radius literal where that file's
   `:root` declares the role. A new role gets a named property first.
4. **Unused local tokens** — no `:root` property outside the foundation that
   nothing consumes. The foundation is exempt: it is one palette copied into
   five files, so a token one artboard does not use is expected.
5. **Foundation identity** — CSS byte-identical, markup identical bar the
   current item and the click wiring described above.

## Editing and publishing

The repo files are the working copy; the published artifact is a build output.
Edit locally first, then upload.

1. Edit the `.dc.html` files and `canvas.json` here.
2. Read the live artifact before publishing, to confirm nobody edited it in the
   browser and saved. A publish replaces the whole page with a freshly built
   copy of these files, so an unread browser edit would be destroyed.
3. Run `check-artboards.mjs`.
4. Publish the changed artboards to the Design canvas above as its
   `project/<file>` files (the Design type's own runtime serves `support.js`).
   Its index is `project/canvas.json` in the Design type's v3 shape, converted
   from this folder's `canvas.json`: `artboards` become `boards` keyed by file
   plus `order`, and `annotations` become `notes`. Send the index only when the
   layout, notes or title change.

Never run an extract of the canvas into this directory: these files are ahead of
the canvas's history, and extracting would overwrite committed work.

> The earlier note here said Relatórios and Follow-up were "repo-only; do not
> republish to claude.ai". That was never a policy — the work ran in Cursor,
> which cannot publish to claude.ai, so only the local half of the loop was
> possible and the gap was written up as though it were a decision. The same
> partial commit is why the Relatórios artboard lost its state switch. Removed
> 2026-09-01 by the `revise-mvp-canvas-designs` change, which completes the
> republish `relatorios-funnel-insights` task 3.1 had specified.
