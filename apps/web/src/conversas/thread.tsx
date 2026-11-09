/**
 * Thread pane: message list, ticks, media, composer.
 */
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MEDIA_MAX_BYTES,
  type ChannelStatus,
  type ConversationMessage,
  type ConversationSummary,
} from "@select-lub/shared-types";
import { fetchMessageMedia, fetchMessages, sendMedia, sendText } from "../api.js";
import { THREAD_STAGE_LABELS } from "./inboxLink.js";
import { messageBodyId, OutboundFailure, RESENT_LABEL } from "./outbound-failure.js";
import {
  dayKey,
  isPlayableMedia,
  messageTypeFromFile,
  saoPauloDate,
  saoPauloTime,
  whatsappWebUrl,
} from "./helpers.js";

export function ThreadPane({
  conversation,
  draft,
  setDraft,
  channelQuery,
  targetMessageId,
}: {
  conversation: ConversationSummary | null;
  draft: string;
  setDraft: (value: string) => void;
  channelQuery: UseQueryResult<ChannelStatus>;
  /**
   * A message to open positioned on, from a screen that sent the reader here
   * because of one message rather than the conversation as a whole — Follow-up's
   * Orçamentos sem resposta, say. Absent, unknown, or belonging to a different
   * conversation all degrade to the thread's normal position; nothing errors,
   * since the message may have been deleted between that screen's read and the
   * click.
   */
  targetMessageId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [attachment, setAttachment] = useState<File | null>(null);
  const [sizeError, setSizeError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textIdempotencyKeyRef = useRef<string | null>(null);
  const mediaIdempotencyKeyRef = useRef<string | null>(null);
  const messagesQuery = useQuery({
    queryKey: ["messages", conversation?.id],
    queryFn: () => fetchMessages(conversation!.id),
    enabled: Boolean(conversation),
    refetchInterval: 3_000,
  });
  const sendMutation = useMutation({
    mutationFn: (text: string) => {
      textIdempotencyKeyRef.current ??= crypto.randomUUID();
      return sendText(conversation!.id, text, textIdempotencyKeyRef.current);
    },
    onSuccess: async () => {
      textIdempotencyKeyRef.current = null;
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: ["messages", conversation?.id] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const sendMediaMutation = useMutation({
    mutationFn: (input: {
      file: File;
      messageType: "image" | "audio" | "document" | "video";
      caption?: string;
    }) => {
      mediaIdempotencyKeyRef.current ??= crypto.randomUUID();
      return sendMedia(conversation!.id, input, mediaIdempotencyKeyRef.current);
    },
    onSuccess: async () => {
      mediaIdempotencyKeyRef.current = null;
      setDraft("");
      setAttachment(null);
      setSizeError(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await queryClient.invalidateQueries({ queryKey: ["messages", conversation?.id] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  if (!conversation) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>Selecione uma conversa</Typography>
      </Box>
    );
  }

  const sending = sendMutation.isPending || sendMediaMutation.isPending;
  const channelState = channelQuery.data?.state;
  const channelConnected = channelState === "CONNECTED";
  const channelDown = channelQuery.data !== undefined && !channelConnected;
  const canSend = !sending && channelConnected;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending || !channelConnected) {
      return;
    }
    if (attachment) {
      if (attachment.size > MEDIA_MAX_BYTES) {
        setSizeError(true);
        return;
      }
      setSizeError(false);
      const caption = draft.trim();
      sendMediaMutation.mutate({
        file: attachment,
        messageType: messageTypeFromFile(attachment),
        caption: caption === "" ? undefined : caption,
      });
      return;
    }
    const text = draft.trim();
    if (!text) {
      return;
    }
    sendMutation.mutate(text);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Stack
        direction="row"
        spacing={1.5}
        data-testid="conversas-thread-header"
        sx={{ p: 2, borderBottom: 1, borderColor: "divider", alignItems: "center" }}
      >
        <Avatar sx={{ width: 40, height: 40 }}>
          {conversation.contactLabel.trim().charAt(0).toUpperCase()}
        </Avatar>
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography variant="subtitle1">{conversation.contactLabel}</Typography>
            {/* Derived pipeline status (conversas spec: "A conversation carries
                a derived pipeline stage"). A plain styled Box, deliberately not
                a Chip, a Select or anything deletable: the stage is computed
                from the same events REP-15's funnel counts, so an affordance to
                change it would promise a write the API refuses. A Chip here also
                re-styled on every keystroke anywhere on the screen, timing out
                ConversasPage.scheduled.test.tsx's typing case at 30s. */}
            <Box
              sx={{
                px: 1,
                py: 0.25,
                borderRadius: 4,
                bgcolor: "action.hover",
                color: "text.secondary",
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              {THREAD_STAGE_LABELS[conversation.pipelineStage]}
            </Box>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {conversation.phone}
          </Typography>
        </Box>
      </Stack>
      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        {messagesQuery.isLoading ? (
          <Skeleton variant="rectangular" height={120} />
        ) : messagesQuery.isError ? (
          <Stack spacing={1}>
            <Alert severity="error">Não foi possível carregar as mensagens</Alert>
            <Button variant="contained" onClick={() => void messagesQuery.refetch()}>
              Tentar de novo
            </Button>
          </Stack>
        ) : (
          <MessageList
            conversationId={conversation.id}
            messages={messagesQuery.data ?? []}
            targetMessageId={targetMessageId}
            channelConnected={channelConnected}
          />
        )}
      </Box>
      <Box component="form" onSubmit={onSubmit} sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
        {sizeError ? (
          <Alert severity="error" sx={{ mb: 1 }}>
            O arquivo é maior que 16 MiB
          </Alert>
        ) : null}
        {sendMutation.isError || sendMediaMutation.isError ? (
          <Alert severity="error" sx={{ mb: 1 }}>
            Não foi possível enviar a mensagem
          </Alert>
        ) : null}
        {attachment ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {attachment.name}
          </Typography>
        ) : null}
        {channelDown ? (
          /* Blocked bar replaces the compose controls while the channel is
             down (align-shipped-ui-to-canvas F8) — send is structurally
             impossible, not merely disabled. */
          <Alert severity="warning">
            Envio pelo CRM indisponível.{" "}
            {channelState === "DISCONNECTED" ? (
              <Link href={whatsappWebUrl(conversation.phone)} target="_blank" rel="noreferrer">
                Abrir no WhatsApp
              </Link>
            ) : null}
          </Alert>
        ) : (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,audio/*,video/*,.pdf,application/pdf"
              data-testid="conversas-attach-input"
              aria-label="Anexar arquivo"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setAttachment(file);
                setSizeError(false);
              }}
            />
            <Button
              type="button"
              variant="outlined"
              disabled={!canSend}
              onClick={() => fileInputRef.current?.click()}
            >
              Anexar
            </Button>
            <TextField
              label="Mensagem"
              placeholder="Digite uma mensagem"
              fullWidth
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              slotProps={{ htmlInput: { "data-testid": "conversas-composer" } }}
            />
            <Button
              type="submit"
              variant="contained"
              color="whatsapp"
              disabled={!canSend}
              data-testid="conversas-send-button"
            >
              Enviar
            </Button>
          </Stack>
        )}
      </Box>
    </Box>
  );
}

/**
 * Chronological message bubbles grouped by São Paulo calendar day.
 * @param conversationId - CRM conversation id passed to media fetch helpers.
 * @param messages - Message rows from `GET /conversations/:conversationId/messages`.
 */
export function MessageList({
  conversationId,
  messages,
  targetMessageId,
  channelConnected = false,
}: {
  conversationId: string;
  messages: ConversationMessage[];
  /** See {@link ThreadPane}'s prop of the same name. */
  targetMessageId?: string | null;
  /** Whether the channel is `CONNECTED`; Reenviar is disabled otherwise. */
  channelConnected?: boolean;
}) {
  let lastDay = "";
  const ordered = [...messages].sort(
    (a, b) => new Date(a.providerTimestamp).getTime() - new Date(b.providerTimestamp).getTime(),
  );
  // An absent, unknown, or other-conversation target simply matches no row
  // here — the thread renders at its normal position with nothing marked,
  // which is the required degrade, not a special case to detect.
  const targetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [targetMessageId, messages.length]);
  return (
    <Stack spacing={1}>
      {ordered.map((message) => {
        const day = dayKey(message.providerTimestamp);
        const showDay = day !== lastDay;
        lastDay = day;
        const isTarget = targetMessageId !== undefined && targetMessageId !== null && message.id === targetMessageId;
        return (
          <Box key={message.id}>
            {showDay ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                {saoPauloDate.format(new Date(message.providerTimestamp))}
              </Typography>
            ) : null}
            <Box
              ref={isTarget ? targetRef : undefined}
              data-testid={isTarget ? "message-target" : undefined}
              sx={{
                alignSelf: message.direction === "outbound" ? "flex-end" : "flex-start",
                bgcolor: "background.paper",
                border: isTarget ? 2 : 1,
                borderColor: isTarget ? "primary.main" : "divider",
                borderRadius: 1,
                p: 1,
                maxWidth: "80%",
                ml: message.direction === "outbound" ? "auto" : 0,
              }}
            >
              {/* The id lets a control on this bubble name it (Reenviar's aria-describedby). */}
              <Box id={messageBodyId(message.id)}>
                <MessageBody conversationId={conversationId} message={message} />
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
              >
                {message.direction === "outbound" && message.providerStatus === "failed" ? (
                  <Box component="span" sx={{ color: "error.main", fontWeight: 600 }}>
                    Não entregue
                  </Box>
                ) : null}
                {saoPauloTime.format(new Date(message.providerTimestamp))}
                {/* Ticks come only from providerStatus — outbox `confirmed`
                    never renders as read (conversas spec). The raw outbox
                    suffix stays for pre-provider states (queued etc.). */}
                {!message.providerStatus && message.outboxStatus && !message.outboxFailure && !message.outboxResent
                  ? ` · ${message.outboxStatus}`
                  : ""}
                {message.direction === "outbound" &&
                (message.providerStatus === "sent" ||
                  message.providerStatus === "delivered" ||
                  message.providerStatus === "read") ? (
                  <DeliveryTicks status={message.providerStatus} />
                ) : null}
              </Typography>
              {/* hold-unknown-outcome-sends: "Envio incerto" / "Não enviada" in
                  place of the raw suffix, with Reenviar on text. */}
              {/* A blocked send the resend cancelled reads "Reenviada", not " · cancelled". */}
              {message.direction === "outbound" && message.outboxResent && !message.outboxFailure ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {RESENT_LABEL}
                </Typography>
              ) : null}
              {message.direction === "outbound" && message.outboxFailure ? (
                <OutboundFailure
                  conversationId={conversationId}
                  message={{ ...message, outboxFailure: message.outboxFailure }}
                  channelConnected={channelConnected}
                />
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * WhatsApp-style delivery ticks: single check for sent, double for delivered,
 * double in the hand-set readTick blue for read (message-status-ticks-ui D1).
 * @param status - Provider delivery status of an outbound message.
 */
export function DeliveryTicks({ status }: { status: "sent" | "delivered" | "read" }) {
  const theme = useTheme();
  const stroke = status === "read" ? theme.palette.readTick : theme.palette.text.secondary;
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 16 12"
      fill="none"
      data-testid={`tick-${status}`}
      aria-label={
        status === "read" ? "Lida" : status === "delivered" ? "Entregue" : "Enviada"
      }
      role="img"
    >
      <path
        d="M1 6l3.5 3.5L11 2.5"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {status !== "sent" ? (
        <path
          d="M5 6l3.5 3.5L15 2.5"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

/**
 * Renders text or delegates to {@link ThreadMedia} for attachment messages.
 * @param conversationId - CRM conversation id used when loading message media.
 * @param message - One message row from the thread query.
 */
export function MessageBody({
  conversationId,
  message,
}: {
  conversationId: string;
  message: ConversationMessage;
}) {
  if (message.contentUnavailable) {
    // Deleted-at-provider content: Portuguese placeholder, never the old body.
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
        Mensagem indisponível
      </Typography>
    );
  }
  if (isPlayableMedia(message.messageType)) {
    return <ThreadMedia conversationId={conversationId} message={message} />;
  }
  if (message.textBody) {
    return <Typography variant="body2">{message.textBody}</Typography>;
  }
  return (
    <Typography variant="body2" color="text.secondary">
      Mídia não suportada nesta versão
    </Typography>
  );
}

/**
 * Fetches and displays one message attachment inline.
 * @param conversationId - CRM conversation id for `GET …/messages/:messageId/media`.
 * @param message - Message row whose `messageType` selects the renderer (image, audio, video, document).
 */
export function ThreadMedia({
  conversationId,
  message,
}: {
  conversationId: string;
  message: ConversationMessage;
}) {
  const query = useQuery({
    queryKey: ["message-media", conversationId, message.id],
    queryFn: () => fetchMessageMedia(conversationId, message.id),
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(query.data.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [query.data]);

  if (query.isError) {
    return (
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">
          Não foi possível carregar a mídia
        </Typography>
        <Button size="small" variant="contained" onClick={() => void query.refetch()}>
          Tentar de novo
        </Button>
      </Stack>
    );
  }

  if (!query.data || !objectUrl) {
    return <Skeleton variant="rounded" height={120} />;
  }

  const caption = message.textBody;
  const fileName = query.data.fileName ?? caption ?? "Documento";

  return (
    <Stack spacing={1}>
      {message.messageType === "image" ? (
        <Box
          component="img"
          src={objectUrl}
          alt={caption || "Imagem"}
          sx={{ maxWidth: "100%", display: "block" }}
        />
      ) : null}
      {message.messageType === "audio" ? (
        <Box component="audio" controls src={objectUrl} aria-label="Áudio" sx={{ width: "100%" }} />
      ) : null}
      {message.messageType === "video" ? (
        <Box component="video" controls src={objectUrl} aria-label="Vídeo" sx={{ maxWidth: "100%" }} />
      ) : null}
      {message.messageType === "document" ? (
        <Link href={objectUrl} download={fileName}>
          {fileName}
        </Link>
      ) : null}
      {caption && message.messageType !== "document" ? (
        <Typography variant="body2">{caption}</Typography>
      ) : null}
    </Stack>
  );
}
