/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/conversations/instance-name.test.ts (adopt-modular-vertical-slices
 * 4A), all cases, assertions unchanged: the api's Evolution helpers are channel's now,
 * which owns Evolution. Pure; module role: none. fetch is stubbed, never Evolution.
 *
 * Setup: resolveEvolutionInstanceName called directly. No Postgres and no app —
 * the unit under test is the resolution rule itself.
 *
 * Oracle: this replaced a `?? "select-lub-poc"` fallback at two call sites.
 * `.env`, `.env.example` and CI all set `EVOLUTION_INSTANCE_NAME=Select Lub`, so
 * that default could only ever name a connection that exists nowhere, and the
 * miss presents as an empty inbox rather than an error — `resolveUnitId` and
 * `channelStatus` both resolve the connection by this name and return
 * null/DISCONNECTED when the lookup finds nothing. repo-foundation's spec
 * requires the seeded connection to carry "the configured
 * EVOLUTION_INSTANCE_NAME", so an unset variable is a misconfiguration rather
 * than a supported mode.
 *
 * Axes
 *   A1 injected argument — present / absent
 *   A2 EVOLUTION_INSTANCE_NAME — set / unset / blank-or-whitespace
 *
 * Cases
 *   C1 A1 present                     → returns the injected name, env ignored
 *   C2 A1 absent, A2 set              → returns the configured name
 *   C3 A1 absent, A2 unset            → throws, naming the variable
 *   C4 A1 absent, A2 whitespace       → throws (a blank name would silently
 *                                        resolve nothing, same as unset)
 *
 * Out of scope: the callers' behaviour once a name is resolved
 * (conversations/prisma.test.ts). Reports no longer reads the instance name at
 * all: since adopt-modular-vertical-slices 2C its slice takes the unit only from
 * the auth hook's `unitIdOf`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveEvolutionInstanceName } from "./instance-name.js";

describe("resolveEvolutionInstanceName", () => {
  const previous = process.env.EVOLUTION_INSTANCE_NAME;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.EVOLUTION_INSTANCE_NAME;
    } else {
      process.env.EVOLUTION_INSTANCE_NAME = previous;
    }
  });

  it("C1 prefers an injected name over the environment", () => {
    process.env.EVOLUTION_INSTANCE_NAME = "From Env";

    expect(resolveEvolutionInstanceName("Injected")).toBe("Injected");
  });

  it("C2 returns the configured name when nothing is injected", () => {
    process.env.EVOLUTION_INSTANCE_NAME = "Select Lub";

    expect(resolveEvolutionInstanceName()).toBe("Select Lub");
  });

  it("C3 refuses when the variable is unset, naming it", () => {
    delete process.env.EVOLUTION_INSTANCE_NAME;

    // The message has to name the variable: the whole point is that the
    // operator can see which setting is missing, where the old fallback left
    // them with an empty screen and nothing to search for.
    expect(() => resolveEvolutionInstanceName()).toThrowError(/EVOLUTION_INSTANCE_NAME/);
  });

  it("C4 refuses a blank name rather than resolving nothing", () => {
    process.env.EVOLUTION_INSTANCE_NAME = "   ";

    expect(() => resolveEvolutionInstanceName()).toThrowError(/EVOLUTION_INSTANCE_NAME/);
  });
});
