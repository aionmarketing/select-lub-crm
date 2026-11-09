/**
 * What scheduling's HTTP slices need from outside the database.
 *
 * One port: whether the WhatsApp channel is connected, asked LIVE of Evolution
 * at the moment of the request. Confirming a schedule or a reminder, and
 * cancelling a schedule, are refused while it answers false.
 *
 * The live probe is the api's source; the worker's due tick reads the STORED
 * `connection_state` column instead (wave 3, ruling Q4; memory:
 * connectivity-has-two-sources-column-and-probe). The two are different on
 * purpose, so this port is never used by a job.
 *
 * It is an outbound network call: call it OUTSIDE any `db.tx`.
 */

/** Asks Evolution whether the instance is connected right now; false on any error. */
export type ChannelConnected = () => Promise<boolean>;

/** The ports scheduling's routes are built over. */
export interface SchedulingPorts {
  readonly channelConnected: ChannelConnected;
}
