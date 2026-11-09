/**
 * Selects the inbox pieces for the build-time UI variant.
 *
 * Both variants expose the same four components under the same names, with the
 * same accessible names and copy, so the Conversas behavioural tests query them
 * identically whichever variant is built.
 */
import {
  ChannelChip as ChannelChipAntigravity,
  ConversationList as ConversationListAntigravity,
  NovaConversaControl as NovaConversaControlAntigravity,
  TagFilter as TagFilterAntigravity,
} from "./inbox.antigravity.js";
import {
  ChannelChip as ChannelChipCursor,
  ConversationList as ConversationListCursor,
  NovaConversaControl as NovaConversaControlCursor,
  TagFilter as TagFilterCursor,
} from "./inbox.cursor.js";
import { UI_VARIANT } from "../uiVariant.js";

const antigravity = UI_VARIANT === "antigravity";

/** Channel state chip of the active variant. */
export const ChannelChip = antigravity ? ChannelChipAntigravity : ChannelChipCursor;

/** Nova conversa control of the active variant. */
export const NovaConversaControl = antigravity
  ? NovaConversaControlAntigravity
  : NovaConversaControlCursor;

/** Tag filter group of the active variant. */
export const TagFilter = antigravity ? TagFilterAntigravity : TagFilterCursor;

/** Conversation list of the active variant. */
export const ConversationList = antigravity
  ? ConversationListAntigravity
  : ConversationListCursor;
