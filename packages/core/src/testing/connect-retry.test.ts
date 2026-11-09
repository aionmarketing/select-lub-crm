/**
 * Test design — connect-retry
 *
 * SUT: `isTransientConnectionFailure` / `withConnectionRetry`: pure control
 *   flow over an injected opener and an injected sleep. No database.
 * Why these cases: the retry exists to ride over ONE failure shape, Prisma's
 *   "Can't reach database server" initialization error, and must retry nothing
 *   else. A retry that also caught a query error would re-run a test body over
 *   its own half-applied writes and hide a real defect. So the cases pin the
 *   boundary from both sides (the exact error retried; a data error and a
 *   non-Error not retried), the happy path after one drop, and the bounded
 *   give-up.
 * Out of scope: whether the harness actually wires this in; that is
 *   transaction.test.ts, and it cannot be provoked without dropping a socket.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isTransientConnectionFailure,
  withConnectRetry,
  withConnectionRetry,
} from "./connect-retry.js";

/** Builds the error Prisma actually throws for an unreachable server. */
function unreachable(): Error {
  const error = new Error(
    "\nInvalid `prisma.$transaction()` invocation:\n\nCan't reach database server at `127.0.0.1:5433`",
  );
  error.name = "PrismaClientInitializationError";
  return error;
}

/**
 * The error Prisma throws when a connection is dropped mid-query. Same drop,
 * different class: this is the one that failed the live suites on 2026-09-19,
 * while the predicate matched only the class above and so retried nothing.
 */
function droppedMidQuery(): Error {
  const error = new Error(
    "Invalid `client.service.findMany()` invocation: Can't reach database server at `127.0.0.1:5433`",
  );
  error.name = "PrismaClientKnownRequestError";
  return error;
}

/** Builds a query error that reached the server. */
function dataError(): Error {
  const error = new Error("Unique constraint failed on the fields: (`omie_id`)");
  error.name = "PrismaClientKnownRequestError";
  return error;
}

describe("isTransientConnectionFailure", () => {
  it("recognises Prisma's unreachable-server initialization error", () => {
    expect(isTransientConnectionFailure(unreachable())).toBe(true);
  });

  it.each([
    ["a data error that reached the server", dataError()],
    ["an initialization error with another message", Object.assign(new Error("Authentication failed"), { name: "PrismaClientInitializationError" })],
    ["a non-Error throw", "Can't reach database server"],
    ["an ordinary Error quoting the text", new Error("Can't reach database server at `127.0.0.1:5433`")],
  ])("does not match %s", (_label, thrown) => {
    expect(isTransientConnectionFailure(thrown)).toBe(false);
  });

  it("recognises the same drop arriving as a known-request error", () => {
    // The arm the first version missed, which is why the live suites had no
    // retry at all: this is the class they actually saw.
    expect(isTransientConnectionFailure(droppedMidQuery())).toBe(true);
  });
});

describe("withConnectRetry", () => {
  /** A stand-in client whose `$extends` hands back the operation hook it was given. */
  function fakeClient(operation: () => Promise<unknown>) {
    return {
      $extends(args: {
        query: {
          $allOperations: (ctx: {
            args: unknown;
            query: (a: unknown) => Promise<unknown>;
          }) => Promise<unknown>;
        };
      }) {
        return {
          run: () => args.query.$allOperations({ args: { where: {} }, query: () => operation() }),
        };
      },
    };
  }

  /** Wraps the stand-in and exposes the one operation it holds. */
  function wrapped(operation: () => Promise<unknown>, sleep: (ms: number) => Promise<void>) {
    return withConnectRetry(fakeClient(operation), { attempts: 4, sleep }) as unknown as {
      run: () => Promise<unknown>;
    };
  }

  it("warns when it retries, so a silent drop cannot look like a clean run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const operation = vi.fn().mockRejectedValueOnce(droppedMidQuery()).mockResolvedValueOnce(1);

      await wrapped(operation, vi.fn().mockResolvedValue(undefined)).run();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/could not reach the database server/);
    } finally {
      warn.mockRestore();
    }
  });

  it("replays an operation whose connection was dropped mid-query", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(droppedMidQuery())
      .mockResolvedValueOnce([{ id: "service-1" }]);

    await expect(wrapped(operation, vi.fn().mockResolvedValue(undefined)).run()).resolves.toEqual([
      { id: "service-1" },
    ]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not replay an operation the server answered", async () => {
    // The dangerous direction: replaying a write that landed would duplicate
    // it. Only "never reached the server" is retried.
    const operation = vi.fn().mockRejectedValue(dataError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(wrapped(operation, sleep).run()).rejects.toThrow("Unique constraint failed");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("withConnectionRetry", () => {
  it("returns the opener's value after riding over one dropped connection", async () => {
    const open = vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValueOnce("opened");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withConnectionRetry(open, { attempts: 4, sleep })).resolves.toBe("opened");

    expect(open).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("rethrows a data error on the FIRST failure, without retrying", async () => {
    const open = vi.fn().mockRejectedValue(dataError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withConnectionRetry(open, { attempts: 4, sleep })).rejects.toThrow(
      "Unique constraint failed",
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up and rethrows when the server is genuinely unreachable", async () => {
    const open = vi.fn().mockRejectedValue(unreachable());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withConnectionRetry(open, { attempts: 3, sleep })).rejects.toThrow(
      "Can't reach database server",
    );

    // Three attempts, two waits: the budget is attempts, not retries.
    expect(open).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });
});
