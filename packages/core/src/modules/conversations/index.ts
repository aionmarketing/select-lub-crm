/**
 * The conversations module: WhatsApp threads, their messages, tags and
 * templates, and the Follow-up queue built on them. It owns `conversation`,
 * `message`, `tag`, `template`, `conversation_tag` and `follow_up_closed_entry`.
 * The only file the composition roots import; other modules reach it through
 * `contracts/`.
 *
 * - Ingestion (`ingest-message`): the worker subscribes this module's three
 *   handlers to channel's events and runs `retryPendingEvents` on its heartbeat.
 * - {@link createHttpPlugin}: the twenty-one routes, with their paths unchanged from
 *   `apps/api/src/{conversations,tags,follow-up}` — six for the inbox and a
 *   thread, ten for tags and templates, four for Follow-up.
 * - `unansweredQuoteCount`: the reports module's `unansweredQuotes` port, which
 *   the api's composition root binds.
 */
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import { route as applyTagRoute } from "./apply-tag/index.js";
import { route as closeFollowUpRoute } from "./close-follow-up/index.js";
import { route as countFollowUpsRoute } from "./count-follow-ups/index.js";
import { route as createTagRoute } from "./create-tag/index.js";
import { route as createTemplateRoute } from "./create-template/index.js";
import { createRoute as fetchMediaRoute } from "./fetch-media/index.js";
import type { ConversationsPorts } from "./internal/ports.js";
import { route as listConversationsRoute } from "./list-conversations/index.js";
import { route as listFollowUpsRoute } from "./list-follow-ups/index.js";
import { route as listMessagesRoute } from "./list-messages/index.js";
import { route as listTagApplyOptionsRoute } from "./list-tag-apply-options/index.js";
import { route as listTagsRoute } from "./list-tags/index.js";
import { route as listTemplatesRoute } from "./list-templates/index.js";
import { createRoute as openConversationRoute } from "./open-conversation/index.js";
import { createRoute as previewTemplateRoute } from "./preview-template/index.js";
import { route as removeTagRoute } from "./remove-tag/index.js";
import { route as reopenFollowUpRoute } from "./reopen-follow-up/index.js";
import { createRoute as sendMediaRoute } from "./send-media/index.js";
import { createRoute as sendMessageRoute } from "./send-message/index.js";
import { createRoute as resendMessageRoute } from "./resend-message/index.js";
import { route as updateTagRoute } from "./update-tag/index.js";
import { route as updateTemplateRoute } from "./update-template/index.js";

export {
  canonicalizeEvent,
  canonicalizeReceivedWebhooks,
  CLASSIFICATION_RULE_VERSION,
  createIngestStore,
  ingestFetchedHistory,
  ingestHistoryRecord,
  insertSentMessages,
  isHistoryBackfillBlockedBySeed,
  persistRawEvent,
  retryPendingEvents,
  type CanonicalMessage,
  type IngestStore,
  type ProviderStatus,
} from "./ingest-message/index.js";
export { unansweredQuoteCount } from "./internal/follow-up-aggregate.js";
export type { ConversationsPorts, FetchMediaPort, TemplateValues } from "./internal/ports.js";

/**
 * The conversations module's HTTP plugin, over the given ports.
 *
 * The ports live in this closure, one per app: two apps built side by side —
 * every test builds its own — must not share one.
 *
 * @param ports - See {@link ConversationsPorts}.
 * @returns The plugin that registers the module's twenty-one route slices.
 */
export function createHttpPlugin(ports: ConversationsPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "conversations", "list-conversations", listConversationsRoute);
    registerSlice(app, "conversations", "open-conversation", openConversationRoute(ports));
    registerSlice(app, "conversations", "list-messages", listMessagesRoute);
    registerSlice(app, "conversations", "send-message", sendMessageRoute(ports));
    registerSlice(app, "conversations", "send-media", sendMediaRoute(ports));
    registerSlice(app, "conversations", "resend-message", resendMessageRoute(ports));
    registerSlice(app, "conversations", "fetch-media", fetchMediaRoute(ports));
    registerSlice(app, "conversations", "list-tags", listTagsRoute);
    registerSlice(app, "conversations", "list-tag-apply-options", listTagApplyOptionsRoute);
    registerSlice(app, "conversations", "create-tag", createTagRoute);
    registerSlice(app, "conversations", "update-tag", updateTagRoute);
    registerSlice(app, "conversations", "list-templates", listTemplatesRoute);
    registerSlice(app, "conversations", "create-template", createTemplateRoute);
    registerSlice(app, "conversations", "update-template", updateTemplateRoute);
    registerSlice(app, "conversations", "apply-tag", applyTagRoute);
    registerSlice(app, "conversations", "remove-tag", removeTagRoute);
    registerSlice(app, "conversations", "preview-template", previewTemplateRoute(ports));
    registerSlice(app, "conversations", "list-follow-ups", listFollowUpsRoute);
    registerSlice(app, "conversations", "count-follow-ups", countFollowUpsRoute);
    registerSlice(app, "conversations", "close-follow-up", closeFollowUpRoute);
    registerSlice(app, "conversations", "reopen-follow-up", reopenFollowUpRoute);
  };
}
