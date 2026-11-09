/**
 * Demo WhatsApp connections. Instance names never equal the live Evolution name.
 */

export const DEMO_CONNECTION_STATES = ["CONNECTED", "CONNECTING", "DEGRADED", "DISCONNECTED"] as const;

const DEMO_INSTANCE_SUFFIXES = ["connected", "connecting", "degraded", "disconnected"] as const;

/**
 * Builds four demo instance names that cannot collide with the live Evolution instance.
 *
 * @param liveInstanceName - `EVOLUTION_INSTANCE_NAME` (or the seed default).
 * @returns Four unique instance names, one per {@link DEMO_CONNECTION_STATES}.
 */
export function demoInstanceNames(liveInstanceName: string) {
  return DEMO_INSTANCE_SUFFIXES.map((suffix) => {
    const candidate = `select-lub-demo-${suffix}`;
    return candidate === liveInstanceName ? `${candidate}-x` : candidate;
  });
}
