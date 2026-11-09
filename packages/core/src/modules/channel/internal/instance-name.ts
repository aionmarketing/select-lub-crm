/**
 * Single resolver for the configured Evolution instance name.
 *
 * WHY THIS REFUSES RATHER THAN DEFAULTING. Two call sites used to fall back to
 * `"select-lub-poc"`, a name that exists in no environment this repo ships:
 * `.env`, `.env.example` and CI all set `EVOLUTION_INSTANCE_NAME=Select Lub`.
 * So the fallback could only ever name a connection that does not exist.
 *
 * That matters because of HOW the miss presents. Channel identity is resolved by
 * this one name — `resolveUnitId` and `channelStatus` both look the connection up
 * by it — and a lookup that finds nothing returns null or zero rather than
 * raising. The screen then shows an empty inbox, a disconnected badge, or a count
 * of zero, with no error anywhere. A wrong name is indistinguishable from an
 * empty database.
 *
 * The defaults also DISAGREED across the repo, which is what made an unset
 * variable a guaranteed mismatch rather than a coincidence: the e2e seed CREATES
 * its connection with `?? "Select Lub"` while these READ sites looked for
 * `"select-lub-poc"`. Unset, the seed wrote one name and the app searched for
 * another.
 *
 * Refusing at startup converts that silent zero into a message naming the
 * variable. Nothing supported runs without it: `.env.example` lists it, CI sets
 * it, deployment sets it as a secret, and `repo-foundation`'s spec requires the
 * seeded connection to carry "the configured `EVOLUTION_INSTANCE_NAME`".
 *
 * @param injected - Explicit name from a caller (tests pass their own).
 * @returns The instance name to resolve connections by.
 * @throws When no name is injected and `EVOLUTION_INSTANCE_NAME` is unset or blank.
 */
export function resolveEvolutionInstanceName(injected?: string): string {
  const configured = injected ?? process.env.EVOLUTION_INSTANCE_NAME;
  if (!configured?.trim()) {
    throw new Error(
      "EVOLUTION_INSTANCE_NAME is not set. It names the WhatsApp connection this " +
        "API resolves units and channel state by, and a wrong or missing name " +
        "returns an empty inbox rather than an error. Set it to the instance the " +
        "database was seeded with (see .env.example).",
    );
  }
  return configured;
}
