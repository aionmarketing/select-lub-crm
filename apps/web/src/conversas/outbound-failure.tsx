/**
 * The label and **Reenviar** on an outbound message the CRM did not get out
 * (`hold-unknown-outcome-sends`, conversas "Thread shows outbound delivery status"
 * and "Attendant can resend a message that did not go out").
 *
 * The kind comes from the API's `outboxFailure`; the web never reads the outbox's
 * reason text. Every other outbox status keeps the raw suffix the bubble already
 * shows, by the owner's choice.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { ConversationMessage, OutboxFailure } from "@select-lub/shared-types";
import { resendMessage, resendRefusalOf } from "../api.js";

/** The Portuguese label for each kind of "did not go out". */
export const OUTBOUND_FAILURE_LABELS: Readonly<Record<OutboxFailure, string>> = {
  outcome_unknown: "Envio incerto — pode ter chegado. Confira antes de reenviar.",
  not_sent: "Não enviada",
};

/**
 * The DOM id of a message bubble's body, so a control on that bubble can name it
 * (`hold-unknown-followups`: every Reenviar was otherwise just "Reenviar").
 *
 * @param messageId - The thread message's id.
 */
export function messageBodyId(messageId: string): string {
  return `message-body-${messageId}`;
}

/** Shown instead of Reenviar once the message has been resent. */
export const RESENT_LABEL = "Reenviada";

/** Shown instead of Reenviar while the channel is down. */
export const RESEND_DISCONNECTED_REASON = "Canal desconectado — reenvio indisponível.";

function resendErrorCopy(error: unknown): string {
  const refusal = resendRefusalOf(error);
  if (refusal && "state" in refusal) {
    return "Canal desconectado — não foi possível reenviar.";
  }
  if (refusal) {
    return "Esta mensagem não pode mais ser reenviada.";
  }
  return "Não foi possível reenviar a mensagem.";
}

/**
 * The label for an outbound message that did not go out, with Reenviar on text.
 *
 * @param conversationId - The open conversation.
 * @param message - An outbound message carrying `outboxFailure`.
 * @param channelConnected - Whether the channel is `CONNECTED`; Reenviar is
 *   disabled with a reason otherwise, like the composer.
 */
export function OutboundFailure({
  conversationId,
  message,
  channelConnected,
}: {
  conversationId: string;
  message: ConversationMessage & { outboxFailure: OutboxFailure };
  channelConnected: boolean;
}) {
  const queryClient = useQueryClient();
  // A second click can land before the pending state re-renders the button
  // disabled; this stops it synchronously. The server would return the same copy
  // anyway (the key is resend:<id>), but one press is one request.
  const inFlight = useRef(false);
  const resend = useMutation({
    mutationFn: () => resendMessage(conversationId, message.id),
    onSettled: async () => {
      inFlight.current = false;
      // Success shows the new copy; a refusal may mean the row moved on.
      await queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  return (
    <Stack spacing={0.5} sx={{ mt: 0.5, alignItems: "flex-start" }}>
      <Box component="span" sx={{ color: "error.main", fontWeight: 600, typography: "caption" }}>
        {OUTBOUND_FAILURE_LABELS[message.outboxFailure]}
      </Box>
      {message.messageType === "text" && message.outboxResent ? (
        // Already resent: the copy is its own message in the thread.
        <Typography variant="caption" color="text.secondary">
          {RESENT_LABEL}
        </Typography>
      ) : message.messageType === "text" ? (
        <>
          <Button
            size="small"
            variant="outlined"
            aria-describedby={messageBodyId(message.id)}
            disabled={!channelConnected || resend.isPending}
            onClick={() => {
              if (inFlight.current) return;
              inFlight.current = true;
              resend.mutate();
            }}
          >
            {resend.isPending ? "Reenviando…" : "Reenviar"}
          </Button>
          {channelConnected ? null : (
            <Typography variant="caption" color="text.secondary">
              {RESEND_DISCONNECTED_REASON}
            </Typography>
          )}
          {resend.isError ? (
            <Typography variant="caption" color="error.main" role="alert">
              {resendErrorCopy(resend.error)}
            </Typography>
          ) : null}
        </>
      ) : (
        <Typography variant="caption" color="text.secondary">
          Anexe o arquivo de novo para reenviar.
        </Typography>
      )}
    </Stack>
  );
}
