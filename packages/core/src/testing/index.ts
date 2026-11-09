/**
 * Test harness for suites that exercise the real store adapters against the
 * worktree's database. Imported as `@select-lub/core/testing`; never part of the
 * production barrel.
 *
 * Shape of a suite:
 *
 * ```ts
 * describeWithDatabase("conversations routes", () => {
 *   it("lists the unit's conversations", () =>
 *     withTestTransaction(prisma!, async (tx) => {
 *       const unit = await seedUnit(tx);
 *       const app = await buildApp({ db: tx, runInTransaction: runInTransactionOnTx(tx) });
 *       // ...
 *     }));
 * });
 * ```
 */
export {
  describeWithDatabase,
  shouldRunDatabaseTests,
  testDatabaseUrl,
  type DatabaseTestEnv,
} from "./gate.js";
export { seedConnection, seedConversation, seedUnit, seedUser } from "./seed.js";
export { runInTransactionOnTx, withTestTransaction } from "./transaction.js";
export { buildSliceApp, type SliceCaller } from "./slice-app.js";
// The auth hook's fake token table: kernel code, test-only, so it is exported
// here rather than from the production barrel.
export { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "../kernel/auth/get-user.js";
export {
  isTransientConnectionFailure,
  withConnectRetry,
  withConnectionRetry,
  type ConnectRetryOptions,
} from "./connect-retry.js";
export {
  connectionUpdatePayload,
  deletePayload,
  expectedTimestamp,
  historyRow,
  qrUpdatedPayload,
  statusUpdatePayload,
  upsertPayload,
} from "./evolution-payloads.js";
export { MULTIPART_BOUNDARY, multipartPayload } from "./multipart.js";
export {
  DAY_MS,
  dayOffset,
  insertFollowUpMessage,
  insertFollowUpThread,
  seedClosableFollowUp,
  seedFollowUpScenario,
} from "./follow-up-scenario.js";
