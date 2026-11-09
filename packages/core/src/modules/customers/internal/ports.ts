/**
 * The customers module's one outside-world port: the Omie adapter the engine reads
 * from and pushes to, synchronously and outside any transaction (4B ruling Q1a).
 *
 * It lives in `createHttpPlugin`'s closure, one per app, never in the process-wide
 * `bindErp` port: with a process-global, the last `buildApp` in a process wins and
 * two apps with different fakes cross-talk (W2-C6). A test passes its fake.
 */
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";

/** What `createHttpPlugin` takes. */
export type CustomerPorts = {
  /** The Omie adapter the routes use; `createOmieAdapter()` in production. */
  omieAdapter: OmieAdapter;
};
