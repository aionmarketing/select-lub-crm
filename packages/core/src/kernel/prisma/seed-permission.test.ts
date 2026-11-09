/**
 * Test design (testing-strategy)
 *
 * Setup: call resolveSeedPermission with an explicit env object. No database, no
 * filesystem, no .env — so these cases are identical on a developer machine and
 * in CI, and none of them can write a row. The seed entry point itself is not
 * imported: it is a top-level-await script that constructs a Prisma client and
 * calls process.exit, so importing it would run the seed. That is why the
 * decision was extracted here at all.
 *
 * Spec rule (demo-seed — "Seed refuses a non-local target unless explicitly
 * allowed"):
 *   Refuse a non-loopback host, exiting non-zero and naming the host, unless
 *   SEED_ALLOW_REMOTE=1. Fail closed: an unset DATABASE_URL, a value that
 *   cannot be parsed as a URL, or an empty hostname SHALL EACH refuse — that
 *   sentence carries no override clause, and neither does the scenario "An
 *   unusable connection string refuses". Print the resolved host on every run,
 *   including permitted remote runs.
 *
 * Partitions (one numbered group = inputs the spec treats the same):
 *
 *   P1 LOCAL          — loopback host; the override is irrelevant either way
 *   P2 REMOTE         — non-loopback, no override: the case the guard exists for
 *   P3 REMOTE+ALLOW   — non-loopback with SEED_ALLOW_REMOTE=1
 *   P4 ABSENT         — DATABASE_URL unset or blank, no override
 *   P5 ABSENT+ALLOW   — unset WITH the override set
 *   P6 UNPARSEABLE    — set but unreadable, or host-less, no override
 *   P7 UNPARSEABLE+ALLOW — unreadable WITH the override set
 *   P8 BASE           — loopback host naming the pristine conversation base
 *   P9 BASE+ALLOW     — the same, WITH the override set
 *   P10 SIBLING       — loopback host, a database created FROM the base
 *
 * P5 and P7 are the point of this file. The override reads as a blanket
 * "yes, write anyway", and the code only honours it for a `remote` target. A
 * refactor to `if (allowRemote) proceed` passes every other case here and
 * silently lets the seed run with nowhere to write.
 *
 * P8-P10 are the second point. The base is a LOCAL database, so P1's own
 * partition already covers its host and would let it through; the name is the
 * only thing that separates them. P9 exists because the override must not lift
 * this refusal — it says "yes, that remote host", which is not a statement about
 * a local database at all. P10 is the resolution check: without it, a guard that
 * refused every loopback target would pass P8 and P9 while making the seed
 * useless, and nothing here would notice.
 *
 * Output partitions:
 *   O1 — allowed, overridden false, message names the resolved host (P1)
 *   O2 — allowed, overridden true, message names the host AND marks the
 *        override, so a permitted remote run still states where it wrote (P3)
 *   O3 — refused, message names the host it refused (P2)
 *   O4 — refused, message explains the unusable value instead of naming a host
 *        (P4-P7)
 *
 * Limits: the override is exactly "1". Any other spelling ("true", "yes", "0",
 * "") must leave a remote target refused, because a guard a typo can switch off
 * is not a guard.
 *
 * Map from each `it` to a partition:
 *
 *   allows a loopback target and names it            — P1 -> O1
 *   refuses a remote target, naming the host         — P2 -> O3
 *   refuses when the password contains "@"           — P2 -> O3 (spec scenario)
 *   allows a remote target with the override         — P3 -> O2
 *   ignores near-miss override values                — P2 -> O3 (limit)
 *   refuses absent / unparseable without an override  — P4, P6 -> O4
 *   refuses absent / unparseable WITH the override    — P5, P7 -> O4
 *
 * Decision / branch map of resolveSeedPermission:
 *   D1 target.kind === "local"        true: P1        false: P2-P7
 *   D2 target.kind === "remote" (||)  true: P3        false: P5, P7
 *   D3 env.SEED_ALLOW_REMOTE === "1"  true: P3, P5, P7 false: P1, P2, P4, P6
 *   D4 overridden ? marker : ""       true: P3        false: P1
 *   D5 target.kind === "remote" (reason) true: P2     false: P4, P6
 *   D6 target.database === PRISTINE_BASE true: P8, P9 false: P1, P10
 *   No outcome is left one-sided.
 *
 * D6 is checked before D1, and both arms are sampled on a loopback host so the
 * ordering is what the test constrains: move the base check after D1 and P8/P10
 * become indistinguishable, because D1 already returned.
 *
 * What would make a test fail:
 *   Honouring SEED_ALLOW_REMOTE for a target that names no host, which would
 *   let the seed proceed with nothing to write to. Refusing a remote target the
 *   operator explicitly allowed, which pushes them to delete the guard instead.
 *   Dropping the host from the refusal message, leaving an operator who cannot
 *   tell which database was refused. Dropping the override marker from a
 *   permitted remote run, which is the run whose destination matters most.
 */
import { describe, expect, it } from "vitest";
import { resolveSeedPermission, resolveScrubLivePermission } from "./seed-permission.js";
import { PRISTINE_BASE_DATABASE } from "./worktree-database.js";

const LOCAL = "postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub";
const REMOTE = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres";

describe("resolveSeedPermission", () => {
  it("allows a loopback target and says where it will write", () => {
    const permission = resolveSeedPermission({ DATABASE_URL: LOCAL });

    expect(permission.kind).toBe("allowed");
    expect(permission).toMatchObject({ overridden: false });
    expect(permission.message).toContain("127.0.0.1");
    expect(permission.message).not.toContain("SEED_ALLOW_REMOTE=1");
  });

  it("refuses a remote target, naming the host it refused", () => {
    const permission = resolveSeedPermission({ DATABASE_URL: REMOTE });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain("db.example.supabase.co");
  });

  it("refuses a remote target whose password itself contains an at-sign", () => {
    // Splitting the string on "@" would read a fragment of the password as the
    // host and could classify the hosted database as local. The production URL
    // has this shape, which is why the seed's own spec scenario names it.
    const permission = resolveSeedPermission({
      DATABASE_URL: "postgresql://postgres:p@ss@w0rd@db.example.supabase.co:5432/postgres",
    });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain("db.example.supabase.co");
  });

  it("allows a remote target with the override, and marks the run as overridden", () => {
    const permission = resolveSeedPermission({
      DATABASE_URL: REMOTE,
      SEED_ALLOW_REMOTE: "1",
    });

    expect(permission.kind).toBe("allowed");
    expect(permission).toMatchObject({ overridden: true });
    expect(permission.message).toContain("db.example.supabase.co");
    expect(permission.message).toContain("SEED_ALLOW_REMOTE=1");
  });

  it.each(["true", "yes", "on", "0", "", "TRUE"])(
    "does not accept %o as the override",
    (value) => {
      expect(
        resolveSeedPermission({ DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: value }).kind,
      ).toBe("refused");
    },
  );

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["whitespace", "   "],
    ["not a URL", "not-a-url"],
    ["a scheme with no host", "postgresql:///only-a-path"],
  ])("refuses a %s DATABASE_URL", (_label, value) => {
    const permission = resolveSeedPermission({ DATABASE_URL: value });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain("refusing to seed");
  });

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["whitespace", "   "],
    ["not a URL", "not-a-url"],
    ["a scheme with no host", "postgresql:///only-a-path"],
  ])("still refuses a %s DATABASE_URL when SEED_ALLOW_REMOTE=1", (_label, value) => {
    // The override permits a named remote host. These values name no host, so
    // there is nothing for it to permit, and demo-seed's "SHALL each refuse" is
    // written without an override clause. A refactor to `if (allowRemote)
    // proceed` would pass every other case in this file and fail only here.
    const permission = resolveSeedPermission({
      DATABASE_URL: value,
      SEED_ALLOW_REMOTE: "1",
    });

    expect(permission.kind).toBe("refused");
  });

  // P8-P10. Every URL below is loopback, so the host check permits all three and
  // only the database name separates them.
  const onLoopback = (database: string) =>
    `postgresql://selectlub:selectlub@127.0.0.1:5433/${database}`;

  it("refuses the pristine conversation base, naming the database it refused", () => {
    const permission = resolveSeedPermission({ DATABASE_URL: onLoopback(PRISTINE_BASE_DATABASE) });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain(PRISTINE_BASE_DATABASE);
    // The host alone would not tell an operator which database was refused,
    // since every worktree database shares it.
    expect(permission.message).toContain("127.0.0.1");
  });

  it("still refuses the base when SEED_ALLOW_REMOTE=1", () => {
    // The override permits a named remote host. The base is local, so the
    // override has nothing to say about it — and a refusal the override could
    // lift would not protect the one target whose damage cannot be re-seeded away.
    const permission = resolveSeedPermission({
      DATABASE_URL: onLoopback(PRISTINE_BASE_DATABASE),
      SEED_ALLOW_REMOTE: "1",
    });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain(PRISTINE_BASE_DATABASE);
  });

  it("allows a database created from the base, on the same host", () => {
    // The resolution check. A guard that refused every loopback target would
    // satisfy both assertions above and make the seed unusable; only this one
    // fails on it.
    const permission = resolveSeedPermission({
      DATABASE_URL: onLoopback(`${PRISTINE_BASE_DATABASE}_worktree`),
    });

    expect(permission.kind).toBe("allowed");
    expect(permission).toMatchObject({ overridden: false });
  });

  it("allows a remote target with the override even though its name resembles nothing local", () => {
    // Guards against the base check being written as a substring match: a remote
    // database called "postgres" must still travel the D1/D3 path unchanged.
    const permission = resolveSeedPermission({ DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: "1" });

    expect(permission.kind).toBe("allowed");
    expect(permission).toMatchObject({ overridden: true });
  });
});

describe("resolveScrubLivePermission", () => {
  it("allows a loopback target", () => {
    const permission = resolveScrubLivePermission({ DATABASE_URL: LOCAL });

    expect(permission.kind).toBe("allowed");
    expect(permission.message).toContain("127.0.0.1");
    expect(permission.message).toMatch(/^scrub-live:/);
  });

  it("refuses a remote target, naming the host, with no deletes implied", () => {
    const permission = resolveScrubLivePermission({ DATABASE_URL: REMOTE });

    expect(permission.kind).toBe("refused");
    expect(permission.message).toContain("db.example.supabase.co");
  });

  it("allows the pristine conversation base, unlike the seed", () => {
    // repo-foundation: live-scrub is the allowed write that strips real bodies
    // from the base after import. Cadastro still cannot land there.
    const permission = resolveScrubLivePermission({
      DATABASE_URL: `postgresql://selectlub:selectlub@127.0.0.1:5433/${PRISTINE_BASE_DATABASE}`,
    });

    expect(permission.kind).toBe("allowed");
    expect(permission.target).toMatchObject({ database: PRISTINE_BASE_DATABASE });
  });
});
