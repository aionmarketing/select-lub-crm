/**
 * Where each figure of a verified oil spec came from, as the quote dialog shows it (D11,
 * owner 2026-09-25): each SAE grade is cited to a source that lists it, and the liters to
 * the source that stated them. Attendant-side only — the customer message never carries a
 * source.
 */
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { QuoteCitedSource, QuoteGradeSource } from "@select-lub/shared-types";

/** One source and what it is cited for. */
type SourceGroup = { source: QuoteCitedSource; grades: string[]; liters: boolean };

function sameSource(a: QuoteCitedSource, b: QuoteCitedSource): boolean {
  return (
    a.sourcePublisher === b.sourcePublisher &&
    a.sourceDocument === b.sourceDocument &&
    a.sourcePage === b.sourcePage &&
    a.sourceUrl === b.sourceUrl
  );
}

/**
 * Groups the grades by source, in the order the grades are listed, and attaches the liters
 * to the group whose source stated them — or to a group of their own.
 */
export function groupSources(
  gradeSources: QuoteGradeSource[],
  litersSource: QuoteCitedSource | undefined,
): SourceGroup[] {
  const groups: SourceGroup[] = [];
  for (const { grade, ...source } of gradeSources) {
    const group = groups.find((g) => sameSource(g.source, source));
    if (group) {
      group.grades.push(grade);
    } else {
      groups.push({ source, grades: [grade], liters: false });
    }
  }
  // A volume the attendant kept (D24) has no cited source: the caller credits it to the attendant.
  if (!litersSource) return groups;
  const litersGroup = groups.find((g) => sameSource(g.source, litersSource));
  if (litersGroup) {
    litersGroup.liters = true;
  } else {
    groups.push({ source: litersSource, grades: [], liters: true });
  }
  return groups;
}

/** `a`, `a e b`, `a, b e c`. */
function joinPt(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

/** `de 0W-20`, `de 0W-20 e do volume de troca`, `do volume de troca`. */
function citedFor(group: SourceGroup): string {
  if (group.grades.length === 0) {
    return "do volume de troca";
  }
  return `de ${joinPt(group.grades)}${group.liters ? " e do volume de troca" : ""}`;
}

function SourceText({ source }: { source: QuoteCitedSource }) {
  return (
    <>
      {source.sourcePublisher} — {source.sourceDocument} ({source.sourcePage})
      {/* A web-found page is not committed anywhere, so the attendant gets the link: it
          is the only way to check what the quote was grounded on. */}
      {source.sourceUrl == null ? null : (
        <>
          {" — "}
          <Link href={source.sourceUrl} target="_blank" rel="noreferrer noopener">
            {source.sourceUrl}
          </Link>
        </>
      )}
    </>
  );
}

/**
 * The header's source lines: one `Fonte:` line when every grade and the liters share a
 * source, as before per-grade provenance; otherwise one line per source naming what it is
 * cited for.
 */
export function QuoteSources({
  gradeSources,
  litersSource,
}: {
  gradeSources: QuoteGradeSource[];
  litersSource: QuoteCitedSource | undefined;
}) {
  const groups = groupSources(gradeSources, litersSource);
  if (groups.length === 1) {
    return (
      <Typography variant="caption">
        Fonte: <SourceText source={groups[0]!.source} />
      </Typography>
    );
  }
  return groups.map((group) => (
    <Typography key={citedFor(group)} variant="caption">
      Fonte {citedFor(group)}: <SourceText source={group.source} />
    </Typography>
  ));
}

/**
 * The card's caption: the source its grade is cited to. The grade is found the way the
 * catalog matched the card to it — trimmed, case-insensitive.
 */
export function CardSource({ grade, gradeSources }: { grade: string; gradeSources: QuoteGradeSource[] }) {
  const norm = (value: string) => value.trim().toLowerCase();
  const cited = gradeSources.find((entry) => norm(entry.grade) === norm(grade));
  if (!cited) {
    return null;
  }
  return (
    <Typography variant="caption" sx={{ display: "block" }}>
      Fonte de {cited.grade}: {cited.sourcePublisher} — {cited.sourceDocument} ({cited.sourcePage})
    </Typography>
  );
}
