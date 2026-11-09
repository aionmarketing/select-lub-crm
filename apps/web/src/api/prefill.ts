/**
 * Prefill suggestion HTTP.
 */
import {
  prefillSuggestionSchema,
  type PrefillAcceptBody,
  type PrefillFieldKey,
  type PrefillSuggestion,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Loads AI-assisted cadastro field suggestions for the conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Parsed `PrefillSuggestion` from `GET /conversations/:conversationId/prefill`.
 */
export async function fetchPrefill(conversationId: string): Promise<PrefillSuggestion> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/prefill`),
  );
  return prefillSuggestionSchema.parse(body);
}

/**
 * Accepts one suggested prefill field into the customer record.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param body - Field key and coerced value the attendant confirmed.
 * @returns Updated `PrefillSuggestion` from `POST /conversations/:conversationId/prefill/accept`.
 */
export async function acceptPrefillField(
  conversationId: string,
  body: PrefillAcceptBody,
): Promise<PrefillSuggestion> {
  const json = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/prefill/accept`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return prefillSuggestionSchema.parse(json);
}

/**
 * Persists every currently pending prefill field in one request.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Updated `PrefillSuggestion` from `POST /conversations/:conversationId/prefill/accept-all`.
 */
export async function acceptAllPrefill(conversationId: string): Promise<PrefillSuggestion> {
  const json = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/prefill/accept-all`, {
      method: "POST",
      headers: headers(),
    }),
  );
  return prefillSuggestionSchema.parse(json);
}

/**
 * Dismisses one suggested prefill field without writing it to cadastro.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param field - Cadastro field key to reject from the pending suggestion set.
 * @returns Updated `PrefillSuggestion` from `POST /conversations/:conversationId/prefill/reject`.
 */
export async function rejectPrefillField(
  conversationId: string,
  field: PrefillFieldKey,
): Promise<PrefillSuggestion> {
  const json = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/prefill/reject`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ field }),
    }),
  );
  return prefillSuggestionSchema.parse(json);
}

/**
 * Re-runs prefill extraction after the attendant rejects or edits suggestions.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Fresh `PrefillSuggestion` from `POST /conversations/:conversationId/prefill/retry`.
 */
export async function retryPrefill(conversationId: string): Promise<PrefillSuggestion> {
  const json = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/prefill/retry`, {
      method: "POST",
      headers: headers(),
    }),
  );
  return prefillSuggestionSchema.parse(json);
}

/**
 * Turns language-model cadastro extraction on or off for this conversation.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param extractEnabled - Next persisted switch value.
 * @returns Updated `PrefillSuggestion` from `PATCH /conversations/:conversationId/prefill/extract-enabled`.
 */
export async function patchPrefillExtractEnabled(
  conversationId: string,
  extractEnabled: boolean,
): Promise<PrefillSuggestion> {
  const json = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/prefill/extract-enabled`, {
      method: "PATCH",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ extractEnabled }),
    }),
  );
  return prefillSuggestionSchema.parse(json);
}
