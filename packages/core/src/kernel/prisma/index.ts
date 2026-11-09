/** Public barrel for the CRM Prisma client. `prisma` is `null` when `DATABASE_URL` is unset. */
export { prisma } from "./client.js";
export { Prisma, PrismaClient } from "@prisma/client";
export {
  LOOPBACK_HOSTS,
  describeDatabaseTarget,
  resolveDatabaseTarget,
  type DatabaseTarget,
} from "./database-target.js";
export { RemoteDatabaseTestTargetError, shouldRunLiveTests } from "./live-test-gate.js";
export { runInTransactionFor, type DbClient, type RunInTransaction } from "./transaction.js";
export {
  MESSAGE_ORIGIN_LIVE,
  MESSAGE_ORIGIN_SEED,
  MESSAGE_ORIGINS,
  type MessageOrigin,
} from "../../shared/message-origin.js";
export { resolveSeedPermission, resolveScrubLivePermission } from "./seed-permission.js";
export { scrubLiveDataset, type ScrubLiveResult } from "./scrub-live.js";
export { CATALOG_SEED_ROWS, seedCatalogItems } from "./catalog-seed.js";
export { oilSourceFixtures, type OilSourceFixture } from "./oil-source-fixtures.js";
export {
  oilSourceBlocklist,
  findBlock,
  hostOf,
  matchesDomain,
  type BlockedDomain,
} from "./oil-source-blocklist.js";
export {
  CLASSIFICATION_TIER,
  tierForClassification,
  type CandidateClassification,
} from "./source-tier.js";
export {
  tecfilCaptureFixtures,
  type TecfilCaptureRow,
  type TecfilCaptureFilter,
} from "./tecfil-capture-fixtures.js";
// Re-exported so the e2e stack can derive its dedicated database name with the
// repo's own convention rather than a second copy of it. Both were internal to
// `db:worktree-env` until 2026-09-17; nothing about them changed.
export {
  buildLocalDatabaseUrl,
  deriveWorktreeDatabaseName,
  LOCAL_POSTGRES_ENDPOINT,
} from "./worktree-database.js";
