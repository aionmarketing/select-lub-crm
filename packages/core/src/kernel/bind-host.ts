/**
 * Resolves the HTTP bind address for the worker webhook server.
 *
 * @param env - Process environment map; defaults to `process.env`.
 * @returns `WORKER_HOST` when set, otherwise `"127.0.0.1"`.
 */
export function resolveWorkerHost(env: NodeJS.ProcessEnv = process.env) {
  return env.WORKER_HOST ?? "127.0.0.1";
}
