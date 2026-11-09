/**
 * `@select-lub/core` — the kernel, the shared kernel, and the modules.
 *
 * The apps import the kernel to build themselves and each module's plugin to
 * register it. A module is imported through `@select-lub/core/modules/<name>`,
 * never through this barrel, so nothing can reach a module's internals by
 * accident.
 */
export * as kernel from "./kernel/index.js";
export * as clients from "./kernel/clients/index.js";
export * as shared from "./shared/index.js";
