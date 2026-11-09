/**
 * The kernel: everything a slice may assume exists.
 *
 * `README.md` beside this file is the list an agent is allowed to rely on. If
 * something a slice needs is not exported here, that is a core change, not a
 * slice change — record it under the slice's "Blocked on core" heading rather
 * than reaching around the kernel.
 */
export { createDb, withModuleRole, type Db, type DbClient, type RunInTransaction } from "./db.js";
export { MODULE_NAMES, OWNED, roleFor, type ModuleName, type Owned } from "./db.modules.generated.js";
export { buildApp, registerSlice, stripApiPrefix, type App, type BuildAppOptions, type HttpPlugin, type Method, type SliceRoute } from "./http.js";
export { createJobRegistry, createStop, messageOf, runOnce, singleFlight, type Job, type JobErrorReporter, type RegisterJob, type RunningJobs } from "./jobs.js";
export { capture, defineEvent, publish, resetSubscribers, subscribe, type EventDefinition, type Subscriber } from "./events.js";
export { err, isErr, isOk, ok, type Err, type Ok, type Result } from "./result.js";
export { bindDb, unitIdOf } from "./request.js";
export { registerAuthHook, type CallerDirectory } from "./auth/hook.js";
export { createSupabaseGetUser, type AuthUser, type GetUser } from "./auth/get-user.js";
export { registerApiHealth, registerWorkerHealth } from "./health.js";
export { registerSpa, resolveSpaRoot } from "./spa.js";
export { buildWebhookApp, WEBHOOK_BODY_LIMIT } from "./webhook-app.js";
export { resolveWorkerHost } from "./bind-host.js";
export { resolveWorkerSettings, type WorkerSettings } from "./worker-settings.js";
export { fastifyLoggerOptions, fastifyLoggerRedactPaths, formatSafeLogLine, omitSensitiveLogFields } from "./logger.js";
export { flag, integer, MissingConfigError, optionalString, requireString, type Env } from "./config.js";
