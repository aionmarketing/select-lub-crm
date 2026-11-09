# e2e/test/tours/runs

One markdown run report per exploration, named `<YYYY-MM-DD>-<area>.md`.

These are committed on purpose. The report, not the spec, is the record of what
was explored: a drive that found a defect produces a report and no spec, and
even a green drive records the steps that could not reach what they intended and
the diagnosis behind each finding. Deleting one loses the only account of that
exploration.

Sections, in order: `Feature`, `Tool and build`, `Tours`, `Guidebook`, `Steps`
(numbered, each with action, observation, oracle, succeeded or failed),
`Diagnosis`, `Findings`, `Transcribed to`.

When a later change touches a screen a tour covers, re-run that tour file and
update its report's `Findings` — that re-run is the Tour da Versão Anterior, and
it is where the regression value of keeping these files lives.

## Roll-ups

A batch of explorations may also leave a `<YYYY-MM-DD>-findings-rollup.md`: one
table of every finding across that batch, what kind each is, and where it went —
a fix and its pin, an `it.skip` holding it open, or why nothing is owed. The
per-area reports stay the record of *what was explored*; the roll-up is the
record of *what was owed and paid*, so a reviewer can triage a batch without
opening every report.

- `2026-09-10-findings-rollup.md` — the retroactive coverage batch (change
  `exploratory-tour-tests`, tasks 5.3–5.11): three real defects, all three now
  fixed and pinned, six surprises, three coverage gaps. Two were held open at
  the time of the batch and closed later: D2, the session wall, by change
  `session-recovery`; D3, the vehicle row's accessible name, once the owner
  ruled on 2026-09-12 that the `aria-label` should be removed rather than
  reworded.

Format and procedure: `skills/testing-exploratory-tours/SKILL.md`.

## Timestamps in these reports are not trustworthy

This machine's clock skewed twice while the retroactive batch was being driven:
forward about 8 hours during 2026-09-10, and about 10.5 hours again overnight
into 2026-09-11. Both were corrected by hand afterwards. So in every report
written in that window — which is all of `2026-09-10-*.md` — the **ordering of
steps is sound, and the absolute times are not**. Never derive a duration by
subtracting two timestamps from those reports.

Checked on 2026-09-11 and clean: no tour spec asserts a date the skew could have
baked in. `conversas-services.tour.spec.ts` compares the reminder default
against `new Date()` at run time rather than against the date it was drafted on,
and the only date literal in the suite is `relatorios.tour.spec.ts`'s
deliberately far-past empty period. The seed derives every date from `now`.

**The discriminator, which cost two sessions a day between them:** comparing the
app to the database proves nothing, because Node and Postgres read the same
system clock and will agree while both are wrong. Only an external source
settles it.

```bash
curl -sI https://www.google.com | grep -i "^date"
```

If you record a wall-clock time in a run report, check it against that first.
