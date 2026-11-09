/**
 * The channel's HTTP contract: the WhatsApp session state the Conversas screen polls.
 *
 * Moved from `packages/shared-types/src/index.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Evolution/Baileys session connectivity state exposed to the Conversas UI. */
export const channelStateSchema = z.enum([
  "CONNECTING",
  "CONNECTED",
  "DEGRADED",
  "DISCONNECTED",
]);

/** Response body for channel health polled by the Conversas screen. */
export const channelStatusSchema = z.object({
  state: channelStateSchema,
});

/** Evolution/Baileys session connectivity state exposed to the Conversas UI. */
export type ChannelState = z.infer<typeof channelStateSchema>;

/** Response body for channel health polled by the Conversas screen. */
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
