/**
 * Which build an image is: its git commit and the UI variant its SPA was bundled with, and
 * the health bodies that report them. Used by `apps/api`, `apps/worker` and `apps/web`.
 *
 * Moved from `packages/shared-types/src/index.ts` (5.1d) with declarations unchanged.
 */

/** UI composition a published SPA bundle was built with. */
export const UI_VARIANT_IDS = ["cursor", "antigravity"] as const;

/** Identifies which shell composition an image's bundled SPA was built with. */
export type UiVariantId = (typeof UI_VARIANT_IDS)[number];

/**
 * `commit` value reported by an image built without the commit build input.
 *
 * Reported rather than omitted on purpose: a verification that compares the
 * published commit to an expected SHA must fail on such an image, and an absent
 * field is easy to compare vacuously.
 */
export const UNKNOWN_COMMIT = "unknown";

/** Matches a full git object name; `commit` is either this or {@link UNKNOWN_COMMIT}. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Environment map shape read by the build-identity resolvers. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads the git commit an image was built from.
 *
 * @param env - Process environment of the running image.
 * @returns `GIT_COMMIT` when it is a full lowercase SHA, else {@link UNKNOWN_COMMIT}.
 */
export function resolveBuildCommit(env: BuildEnv): string {
  const value = env["GIT_COMMIT"]?.trim().toLowerCase() ?? "";
  return COMMIT_SHA_PATTERN.test(value) ? value : UNKNOWN_COMMIT;
}

/**
 * Reads the UI variant an image's SPA was bundled with.
 *
 * Mirrors `apps/web/src/uiVariant.ts`: anything that is not exactly
 * `antigravity` is `cursor`, so the API can never claim a variant the bundle
 * did not get.
 *
 * @param env - Process environment of the running image.
 * @returns The variant id.
 */
export function resolveUiVariant(env: BuildEnv): UiVariantId {
  return env["VITE_UI_VARIANT"] === "antigravity" ? "antigravity" : "cursor";
}

/** Response body for the service health probe. */
export type HealthStatus = {
  status: "ok";
  database?: "connected" | "skipped";
  /** Full git SHA of the build, or {@link UNKNOWN_COMMIT}. */
  commit: string;
  /** Variant the SPA served from this origin was built with. */
  uiVariant: UiVariantId;
};

/** Response body for the worker health probe: no SPA, so no variant. */
export type WorkerHealthStatus = {
  status: "ok";
  /** Full git SHA of the build, or {@link UNKNOWN_COMMIT}. */
  commit: string;
};
