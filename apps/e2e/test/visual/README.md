# Visual geometry specs

Playwright specs that assert the **measurements** behind a visual-QA round, so the
result survives the session that produced it. They measure geometry only. Nothing here
judges appearance — wrapping, rhythm and taste are the owner's call on the PNGs.

Companion to `apps/e2e/capture/visual-qa.mjs`, which writes the PNGs and
`measurements.json` under `artifacts/visual-qa/<subject>/`. The capture is evidence for
a human; these specs are the regression net. Both use the same per-element measurement
(here in `measure.ts`) so a spec failure and a capture finding are the same number.

| File | Claim |
| --- | --- |
| `desktop-overflow.spec.ts` | No element overflows any of the six routes at the 1024 and 1920 width boundaries |
| `zoom-reachability.spec.ts` | At 200% zoom (a 720 px viewport) content that overshoots is still reachable by scrolling, and the document never scrolls sideways |
| `palette-parity.spec.ts` | Switching palette changes colour, never geometry |
| `measure.ts` | Shared measurement + navigation helpers |

Each spec carries its own test-design header naming its oracle, its sampling technique
and what it deliberately leaves out, per
`openspec/specs/repo-foundation/spec.md` §"Machine-checkable spec scenarios are sampled".

## Running them

They need an app already running; they start no servers. Against a dev server on 5199:

```sh
VISUAL_BASE_URL=http://127.0.0.1:5199 pnpm --filter @select-lub/e2e exec \
  playwright test --config test/visual/playwright.visual.config.ts
```

`playwright.visual.config.ts` exists because the shared `apps/e2e/playwright.config.ts`
starts its own web server on port 5173 with `reuseExistingServer: false`, and on the
owner's machine 5173 is permanently held by an unrelated container, so a run from the
shared config dies before any spec executes. The specs are still collected by the shared
config, so in CI they run in the normal suite against the servers it starts.

## Two things a reader should not have to rediscover

**Wait on the `h1`, never on `main`.** Only `PageShell.tsx` renders a `main` landmark,
and `ConversasPage` and `ServicosPage` do not use PageShell — so `main` is absent on two
of the six routes however correctly they render. Gating on it voided 20 of 60 captures
in the 2026-09-07 round while those pages were showing 1416 and 2190 characters of real
content. All six routes render exactly one `h1`.

**`networkidle` is not a render signal.** Under the Vite dev server it fires during a
lull in on-demand module transforms. The same route measured 1416 characters in one
browser context and 11 in the next from an unchanged app, which is why `gotoRoute` waits
for the `h1` after navigation instead of trusting the load state.

## Discrimination was checked, not assumed

A geometry assertion that only ever passes is worthless, and "no element sticks out"
passes perfectly against a blank page. Two guards:

1. Every spec asserts the page rendered (exactly one `h1`, more than 40 characters of
   text) *before* asserting anything about overflow.
2. The overflow assertion was mutation-tested on 2026-09-07: pointing
   `desktop-overflow.spec.ts` at a 720 px viewport, where `/servicos` is known to
   overshoot, failed exactly that one route with the same +44 px and +31 px overshoots
   the capture harness recorded, while the other five routes still passed. The mutation
   was reverted.

Where an assertion is currently vacuous, the spec header says so and names the claim
carrying the weight instead — see `zoom-reachability.spec.ts`.
