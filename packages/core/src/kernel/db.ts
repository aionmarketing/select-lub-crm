/**
 * Database access for slices, and the one place a module's Postgres role is put
 * on and taken off again.
 *
 * `db.tx(module, fn)` opens a transaction, issues `SET LOCAL ROLE
 * module_<name>`, runs `fn`, and issues `RESET ROLE` in a `finally`. Inside the
 * callback the connection is the module's role, so a write to a table the
 * module does not own is refused by Postgres — through the ORM, through raw
 * SQL, and through code nobody has written yet. That is the whole enforcement
 * mechanism; `ownership.json` and `db/grants.generated.sql` are its inputs.
 *
 * `RESET ROLE` is in a `finally` rather than at the end of the happy path
 * because of the test harness. Under `withTestTransaction` the runner is
 * `runInTransactionOnTx`, so `fn` runs on the *test's* transaction rather than
 * a nested one, and the role is set on that outer transaction. Without the
 * reset, everything the test does after calling the slice — seeding fixtures,
 * reading tables to assert on — would run as the module role and fail on the
 * first foreign table. The consequence, accepted here as it was in #102 D2, is
 * that a slice's transaction is not independently atomic under the harness.
 *
 * A `finally` is not enough on its own, which design.md D2 does not say. The
 * refusal this whole mechanism exists to produce is a failed statement, and a
 * failed statement puts Postgres into `25P02` — "current transaction is
 * aborted, commands ignored until end of transaction block". In that state
 * `RESET ROLE` fails too, and its error replaces the `permission denied` the
 * caller was supposed to see. Measured, not predicted: the first run of
 * `roles.test.ts` reported `25P02` instead of the refusal.
 *
 * So the role-scoped work runs inside a SAVEPOINT. On failure the savepoint is
 * rolled back, which both makes the transaction usable again and restores the
 * role `SET LOCAL` had changed; the original error is then rethrown intact.
 * Under the harness this also keeps a rejected foreign write from destroying
 * the enclosing test transaction, so a test can assert on the refusal and then
 * go on reading rows.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";
import type { DbClient, RunInTransaction } from "@select-lub/core/db";
import { runInTransactionFor } from "@select-lub/core/db";
import { type ModuleName, roleFor } from "./db.modules.generated.js";

export type { DbClient, RunInTransaction };
export { type ModuleName, type Owned, MODULE_NAMES, OWNED, roleFor } from "./db.modules.generated.js";

/**
 * One level of `db.tx` on one transaction. Calls made directly inside it queue
 * on its `tail`, one at a time; calls made inside one of those get a frame of
 * their own. A queue per level rather than per transaction, because a nested
 * call waiting on its own outer call would never start.
 */
interface Frame {
  tail: Promise<void>;
}

/** What one transaction has open. Keyed by the transaction client. */
interface TxState {
  /** The queue for top-level calls on this transaction. */
  readonly root: Frame;
  /** Savepoints opened so far, so each has its own name. */
  savepoints: number;
  /** The roles currently set, innermost last, so leaving one restores its caller's. */
  readonly roles: string[];
}

const states = new WeakMap<object, TxState>();

/** The frame this async context is running in, per transaction. */
const frames = new AsyncLocalStorage<ReadonlyMap<object, Frame>>();

function stateOf(tx: DbClient): TxState {
  let state = states.get(tx);
  if (!state) {
    state = { root: { tail: Promise.resolve() }, savepoints: 0, roles: [] };
    states.set(tx, state);
  }
  return state;
}

/**
 * Runs `fn` in a transaction under `module`'s Postgres role.
 *
 * Two `db.tx` calls that land on the same transaction run one after the other,
 * never interleaved. In production that never happens, since each call opens
 * its own transaction and they run in parallel. Under the test harness every
 * call joins the test's one transaction, and interleaving there would release
 * one call's savepoint under another's feet. A call made inside `fn` — a
 * contract of another module — runs at once, in its own queue, and on the way
 * out puts the caller's role back rather than dropping to the login role, so
 * the caller's later writes are still checked.
 *
 * @param module - The module the work is done on behalf of. Decides the role.
 * @param fn - The work. Receives the transaction client; every write it makes
 *   is checked against the module's grants.
 * @param runInTransaction - How to open the transaction. Defaults to the
 *   client's own `$transaction`; the test harness passes
 *   `runInTransactionOnTx(tx)` so the work joins the test's rolling-back
 *   transaction instead of opening one Prisma would reject.
 * @returns Whatever `fn` resolved with.
 * @throws Whatever `fn` threw — including Postgres's `permission denied` when
 *   the module wrote a table it does not own.
 */
export async function withModuleRole<T>(
  module: ModuleName,
  fn: (tx: DbClient) => Promise<T>,
  runInTransaction: RunInTransaction,
): Promise<T> {
  const role = roleFor(module);
  return runInTransaction(async (tx) => {
    const state = stateOf(tx);
    const inherited = frames.getStore();
    const parent = inherited?.get(tx) ?? state.root;

    const previous = parent.tail;
    let release!: () => void;
    parent.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    // Running inside another module's `db.tx`, on a client object this kernel has
    // no record of. That is either a genuinely separate transaction, or a wrapper
    // (a Proxy, a recording client) around the SAME transaction. Identity cannot
    // tell the two apart, and guessing wrong on the second would end this call
    // with RESET ROLE and leave the caller's later writes unchecked — a write
    // Postgres then allows, so nothing would fail. Ask the database instead.
    const askDatabase =
      inherited !== undefined && inherited.size > 0 && !inherited.has(tx) && state.roles.length === 0;

    const scope = new Map(inherited ?? []);
    scope.set(tx, { tail: Promise.resolve() });
    try {
      return await frames.run(scope, () => underRole(tx, state, role, fn, askDatabase));
    } finally {
      release();
    }
  });
}

async function underRole<T>(
  tx: DbClient,
  state: TxState,
  role: string,
  fn: (tx: DbClient) => Promise<T>,
  askDatabase: boolean,
): Promise<T> {
  state.savepoints += 1;
  const savepoint = `module_role_${state.savepoints}`;
  const caller = askDatabase ? await moduleRoleInEffect(tx) : state.roles.at(-1);
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  // SET LOCAL, so the role is scoped to this transaction and a connection
  // returned to the pool mid-flight cannot carry it to the next caller.
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
  state.roles.push(role);
  try {
    const value = await fn(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch (error) {
    // Clears the aborted state, so the statement below and everything after it
    // can run, and rewinds the role to what it was at the savepoint.
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    throw error;
  } finally {
    state.roles.pop();
    // Back to the caller's module role when nested, else to the login role.
    await tx.$executeRawUnsafe(caller ? `SET LOCAL ROLE ${caller}` : "RESET ROLE");
  }
}

/**
 * The module role set on this transaction right now, if any.
 *
 * Only asked for in the rare case {@link withModuleRole} describes: a nested
 * call on a client object the kernel does not recognise. `current_user` is the
 * role a `SET ROLE` put in effect; the login role is not a module role, so it
 * maps to "no caller role", and the exit then resets as a top-level call does.
 */
async function moduleRoleInEffect(tx: DbClient): Promise<string | undefined> {
  const rows = await tx.$queryRawUnsafe<{ current_user: string }[]>("SELECT current_user");
  const user = rows[0]?.current_user;
  return user !== undefined && user.startsWith("module_") ? user : undefined;
}

/** The database handle a composition root binds and slices are handed. */
export interface Db {
  /** The underlying client, for the few places that need it outside a module role (health checks). */
  readonly client: DbClient | PrismaClient;
  /**
   * Runs `fn` under `module`'s role. See {@link withModuleRole}.
   *
   * @param module - The owning module.
   * @param fn - The work.
   * @param runInTransaction - Overrides how the transaction is opened; the test
   *   harness passes its own runner.
   */
  tx<T>(
    module: ModuleName,
    fn: (tx: DbClient) => Promise<T>,
    runInTransaction?: RunInTransaction,
  ): Promise<T>;
}

/**
 * Binds a database handle to a client.
 *
 * @param client - The Prisma singleton in production, or a transaction client
 *   under the test harness.
 * @param defaultRunInTransaction - The runner used when `tx` is called without
 *   one. Defaults to `runInTransactionFor(client)`, which opens a real
 *   transaction on a singleton and reuses the open one on a transaction client.
 * @returns The handle slices are given.
 */
export function createDb(
  client: DbClient | PrismaClient,
  defaultRunInTransaction?: RunInTransaction,
): Db {
  const fallback = defaultRunInTransaction ?? runInTransactionFor(client);
  return {
    client,
    tx: (module, fn, runInTransaction) =>
      withModuleRole(module, fn, runInTransaction ?? fallback),
  };
}
