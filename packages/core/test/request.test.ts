/**
 * Test design — the database decoration and the current-unit accessor
 *
 * SUT: `bindDb` and `unitIdOf` from `kernel/request.ts`, through
 *   `kernel/http.ts`'s `buildApp` and `registerSlice`, driven by `app.inject`.
 *   No database: the `Db` here is a literal whose `tx` returns a marker, since
 *   what is under test is which handle a handler receives, not what it does.
 *
 * Why these cases. Every wave 2 slice reads `request.server.db`, and the reason
 *   it is a decoration rather than a process-global binder is per-app
 *   isolation: under the harness each test builds its own app over its own
 *   rollback transaction. So the case that matters is two apps, two handles,
 *   each handler seeing its own. A single app would pass against a global too.
 *
 * Positive control: the second `bindDb` on one app must THROW. Without it, a
 *   decoration that silently replaced the handle would pass the isolation case
 *   while letting two composition steps disagree about the database.
 *
 * `unitIdOf` has two partitions: a field the hook set, and a request the hook
 *   left unscoped (a unit-exempt path). The hook itself is `apps/api`'s and is
 *   tested there.
 *
 * `buildSliceApp` is the harness helper every slice's HTTP tests use. Its one
 *   case checks the three things a slice test relies on: the bound handle, the
 *   caller written onto every `crm*` field, and no caller when none is given.
 */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/kernel/db.js";
import { buildApp, registerSlice } from "../src/kernel/http.js";
import { bindDb, unitIdOf } from "../src/kernel/request.js";
import { buildSliceApp } from "../src/testing/slice-app.js";

const fakeDb = (marker: string): Db => ({
  client: {} as never,
  tx: async () => marker as never,
});

const newApp = () => buildApp({ mediaMaxBytes: 1024, corsOrigins: [], quiet: true });

const probe = {
  method: "GET" as const,
  path: "/probe",
  schema: { response: { 200: z.object({ marker: z.string(), unit: z.string().nullable() }) } },
  handler: async (request: import("fastify").FastifyRequest) => ({
    marker: await request.server.db.tx("reports", async () => "unused"),
    unit: unitIdOf(request) ?? null,
  }),
};

describe("bindDb", () => {
  it("gives each app's handlers that app's own handle", async () => {
    const first = await newApp();
    const second = await newApp();
    bindDb(first, fakeDb("first"));
    bindDb(second, fakeDb("second"));
    registerSlice(first, "reports", "probe", probe);
    registerSlice(second, "reports", "probe", probe);

    const [a, b] = await Promise.all([
      first.inject({ method: "GET", url: "/probe" }),
      second.inject({ method: "GET", url: "/probe" }),
    ]);

    expect(a.json()).toEqual({ marker: "first", unit: null });
    expect(b.json()).toEqual({ marker: "second", unit: null });
    await Promise.all([first.close(), second.close()]);
  });

  it("refuses to bind a second handle on the same app", async () => {
    const app = await newApp();
    bindDb(app, fakeDb("first"));
    expect(() => bindDb(app, fakeDb("second"))).toThrow();
    await app.close();
  });
});

describe("unitIdOf", () => {
  it("returns the unit the auth hook resolved", async () => {
    const app = await newApp();
    bindDb(app, fakeDb("m"));
    app.addHook("onRequest", async (request) => {
      request.crmCurrentUnitId = "unit-resolved-by-hook";
    });
    registerSlice(app, "reports", "probe", probe);

    const response = await app.inject({ method: "GET", url: "/probe" });

    expect(response.json()).toEqual({ marker: "m", unit: "unit-resolved-by-hook" });
    await app.close();
  });
});

describe("buildSliceApp", () => {
  it("registers the plugin over the bound handle and writes the stated caller", async () => {
    const plugin = (app: Parameters<typeof registerSlice>[0]) =>
      registerSlice(app, "reports", "probe", {
        ...probe,
        handler: async (request: import("fastify").FastifyRequest) => ({
          marker: await request.server.db.tx("reports", async () => "unused"),
          unit: `${request.crmUserId}@${unitIdOf(request)}:${request.crmUnitIds?.join(",")}`,
        }),
      });

    const app = await buildSliceApp({
      db: fakeDb("slice"),
      plugin,
      caller: { userId: "user-1", unitId: "unit-a", unitIds: ["unit-a", "unit-b"] },
    });
    const anonymous = await buildSliceApp({ db: fakeDb("anon"), plugin: probeOnly });

    expect((await app.inject({ method: "GET", url: "/probe" })).json()).toEqual({
      marker: "slice",
      unit: "user-1@unit-a:unit-a,unit-b",
    });
    expect((await anonymous.inject({ method: "GET", url: "/probe" })).json()).toEqual({
      marker: "anon",
      unit: null,
    });
    await Promise.all([app.close(), anonymous.close()]);
  });
});

function probeOnly(app: Parameters<typeof registerSlice>[0]) {
  registerSlice(app, "reports", "probe", probe);
}
