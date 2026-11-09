/**
 * Inbox list: search chips, nova conversa, channel chip, tag filter, conversation rows.
 */
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChannelStatus, ConversationSummary } from "@select-lub/shared-types";
import { createConversation, fetchTagApplyOptions } from "../api.js";
import { tagChipSx } from "../tagChip.js";
import {
  CHANNEL_STATE_COLORS,
  CHANNEL_STATE_LABELS,
  formatInboxTimestamp,
  ORIGIN_LABELS,
  whatsappWebUrl,
} from "./helpers.js";

/**
 * Channel connection status chip beside the Conversas heading.
 * @param query - TanStack query for `GET /channel/status`; renders nothing until data arrives.
 */
export function ChannelChip({ query }: { query: UseQueryResult<ChannelStatus> }) {
  if (!query.data) {
    return null;
  }
  const state = query.data.state;
  return (
    <Chip
      size="small"
      label={CHANNEL_STATE_LABELS[state]}
      color={CHANNEL_STATE_COLORS[state]}
    />
  );
}

/**
 * Dialog to start a conversation by phone when the channel is connected.
 * @param channelQuery - Channel status query gating CRM send vs WhatsApp Web fallback.
 * @param onCreated - Called with the new conversation id after `POST /conversations` succeeds.
 */
export function NovaConversaControl({
  channelQuery,
  onCreated,
}: {
  channelQuery: UseQueryResult<ChannelStatus>;
  onCreated: (conversationId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const connected = channelQuery.data?.state === "CONNECTED";
  const errorRef = useRef<HTMLDivElement>(null);
  const createMutation = useMutation({
    mutationFn: () => createConversation(phone),
    onSuccess: async (conversation) => {
      setOpen(false);
      setPhone("");
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onCreated(conversation.id);
    },
  });

  useEffect(() => {
    if (createMutation.isError) {
      errorRef.current?.focus();
    }
  }, [createMutation.isError]);

  function close() {
    setOpen(false);
    setPhone("");
    createMutation.reset();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!connected || !phone.trim()) {
      return;
    }
    createMutation.mutate();
  }

  return (
    <>
      <Tooltip title="Nova conversa" placement="top">
        <span>
          <IconButton
            aria-label="Nova conversa"
            onClick={() => setOpen(true)}
            sx={{
              width: 36,
              height: 36,
              bgcolor: "primary.main",
              color: "primary.contrastText",
              flexShrink: 0,
              "&:hover": { bgcolor: "primary.dark" },
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </IconButton>
        </span>
      </Tooltip>
      <Dialog open={open} onClose={close}>
        <DialogTitle>Nova conversa</DialogTitle>
        {connected ? (
          <Box component="form" onSubmit={onSubmit}>
            <DialogContent>
              {createMutation.isError ? (
                <Alert
                  ref={errorRef}
                  tabIndex={-1}
                  id="nova-conversa-erro"
                  severity="error"
                  sx={{ mb: 1 }}
                >
                  Não foi possível abrir a conversa
                </Alert>
              ) : null}
              <TextField
                autoFocus
                label="Telefone"
                placeholder="11999990000"
                fullWidth
                type="tel"
                error={createMutation.isError}
                helperText="Somente dígitos, com DDD"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                slotProps={{
                  htmlInput: {
                    inputMode: "numeric",
                    autoComplete: "tel",
                    "aria-describedby": createMutation.isError
                      ? "nova-conversa-erro nova-conversa-telefone-helper"
                      : "nova-conversa-telefone-helper",
                  },
                  formHelperText: { id: "nova-conversa-telefone-helper" },
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>Cancelar</Button>
              <Button
                type="submit"
                variant="contained"
                disabled={!phone.trim() || createMutation.isPending}
              >
                Iniciar
              </Button>
            </DialogActions>
          </Box>
        ) : (
          <>
            <DialogContent>
              <Typography variant="body2">
                Envio pelo CRM indisponível no momento. Use o WhatsApp Web para iniciar
                essa conversa.
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>Fechar</Button>
              <Button
                component="a"
                href={whatsappWebUrl()}
                target="_blank"
                rel="noreferrer"
                variant="contained"
              >
                Abrir no WhatsApp Web
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}

/**
 * Toggle chips that AND-filter the inbox by tag ids.
 * @param selectedIds - Tag ids currently applied to the inbox filter.
 * @param onChange - Replaces the selected tag id list when a chip is toggled.
 */
export function TagFilter({
  selectedIds,
  onChange,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const query = useQuery({
    queryKey: ["tags", "apply-options"],
    queryFn: fetchTagApplyOptions,
  });
  if (query.isLoading || query.isError || !query.data?.length) {
    return null;
  }
  return (
    // Horizontally scrollable single row — WhatsApp-style filter strip
    <Box
      role="group"
      aria-label="Filtrar por tags"
      sx={{
        display: "flex",
        flexDirection: "row",
        gap: 0.75,
        overflowX: "auto",
        overflowY: "hidden",
        pb: 0.25,
        // Hide scrollbar on webkit
        "&::-webkit-scrollbar": { display: "none" },
        scrollbarWidth: "none",
      }}
    >
      <Chip
        label="Todas"
        size="small"
        variant={selectedIds.length === 0 ? "filled" : "outlined"}
        color={selectedIds.length === 0 ? "primary" : "default"}
        onClick={() => onChange([])}
        aria-pressed={selectedIds.length === 0}
        sx={{ flexShrink: 0 }}
      />
      {query.data.map((tag) => {
        const selected = selectedIds.includes(tag.id);
        return (
          <Chip
            key={tag.id}
            label={tag.name}
            size="small"
            // Only a SELECTED filter chip carries the tag's tint: the
            // unselected one is the outlined variant, and tinting it too
            // would erase the one visual difference between the two states.
            sx={{ flexShrink: 0, ...(selected ? tagChipSx(tag.color) : undefined) }}
            variant={selected ? "filled" : "outlined"}
            onClick={() =>
              onChange(
                selected
                  ? selectedIds.filter((id) => id !== tag.id)
                  : [...selectedIds, tag.id],
              )
            }
            aria-pressed={selected}
          />
        );
      })}
    </Box>
  );
}

/**
 * Scrollable inbox list with loading, error, and empty states.
 * @param query - TanStack query for `GET /conversations`.
 * @param selectedId - Currently highlighted conversation id, or null when none is selected.
 * @param onSelect - Sets the active conversation in {@link useSelection}.
 */
export function ConversationList({
  query,
  selectedId,
  onSelect,
  searchQuery,
  unansweredFilter,
  reportFilterActive = false,
}: {
  searchQuery: string;
  unansweredFilter: boolean;
  /**
   * True when the inbox was opened from a Relatórios drill-through (origin,
   * stage, or period). An empty result under one of these is the cut working
   * correctly, not a search or a filter finding nothing — it gets its own
   * copy so the reader does not read "no conversations" as "the link broke".
   */
  reportFilterActive?: boolean;
  query: ReturnType<typeof useQuery<ConversationSummary[]>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (query.isLoading) {
    return (
      <Stack spacing={1}>
        <Skeleton variant="rounded" height={48} />
        <Skeleton variant="rounded" height={48} />
      </Stack>
    );
  }
  if (query.isError) {
    return (
      <Stack spacing={1}>
        <Alert severity="error">Não foi possível carregar as conversas</Alert>
        <Button variant="contained" onClick={() => void query.refetch()}>
          Tentar de novo
        </Button>
      </Stack>
    );
  }
  if (!query.data?.length) {
    // Distinct copy for a search with zero matches (align-shipped-ui-to-canvas F9)
    if (searchQuery.trim() !== "") {
      return (
        <Typography>Nenhuma conversa para &quot;{searchQuery.trim()}&quot;</Typography>
      );
    }
    if (unansweredFilter) {
      return <Typography>Nenhuma conversa não respondida</Typography>;
    }
    if (reportFilterActive) {
      return <Typography>Nenhuma conversa neste recorte do relatório</Typography>;
    }
    return <Typography>Nenhuma conversa</Typography>;
  }
  return (
    <List disablePadding>
      {query.data.map((row) => {
        // Avatar background: derive a stable colour from the first char of the
        // contact label so the inbox has a splash of colour like WhatsApp.
        const initial = row.contactLabel.trim().charAt(0).toUpperCase();
        const avatarHues = [
          "hsl(20, 60%, 55%)",
          "hsl(190, 45%, 55%)",
          "hsl(250, 45%, 60%)",
          "hsl(120, 35%, 55%)",
          "hsl(340, 45%, 60%)",
          "hsl(45, 50%, 50%)",
        ];
        const avatarBg = avatarHues[initial.charCodeAt(0) % avatarHues.length];

        return (
          <ListItemButton
            key={row.id}
            data-testid="conversas-list-item"
            data-conversation-id={row.id}
            selected={row.id === selectedId}
            onClick={() => onSelect(row.id)}
            sx={{
              alignItems: "center",
              gap: 1.5,
              py: 1,
              px: 1.5,
              borderBottom: "1px solid",
              borderColor: "divider",
              transition: "background-color 120ms",
              "&.Mui-selected": {
                bgcolor: "primaryContainer",
              },
              "&.Mui-selected:hover": {
                bgcolor: "primaryContainer",
                filter: "brightness(0.96)",
              },
            }}
          >
            {/* Round avatar — 48px, letter + colour */}
            <Avatar
              sx={{
                width: 48,
                height: 48,
                flexShrink: 0,
                bgcolor: avatarBg,
                color: "common.white",
                fontWeight: 700,
                fontSize: 18,
              }}
            >
              {initial}
            </Avatar>

            {/* Text block fills the rest */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {/* Row 1: name + timestamp */}
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  mb: 0.25,
                }}
              >
                <Typography
                  component="span"
                  sx={{
                    fontWeight: row.unanswered ? 700 : 500,
                    fontSize: 14,
                    color: "text.primary",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                    mr: 1,
                  }}
                >
                  {row.contactLabel}
                </Typography>
                <Typography
                  component="span"
                  sx={{
                    fontSize: 11,
                    flexShrink: 0,
                    color: row.unanswered ? "primary.main" : "text.disabled",
                    fontWeight: row.unanswered ? 600 : 400,
                  }}
                >
                  {formatInboxTimestamp(row.lastMessageAt)}
                </Typography>
              </Box>

              {/* Row 2: last snippet + unread dot */}
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <Typography
                  component="span"
                  sx={{
                    fontSize: 12,
                    color: "text.secondary",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    fontWeight: row.unanswered ? 600 : 400,
                  }}
                >
                  {row.lastSnippet || (
                    <Box
                      component="span"
                      sx={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0.4,
                        color: "text.disabled",
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden
                      >
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.65 3.38 2 2 0 0 1 3.64 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6 6l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.73 16z" />
                      </svg>
                      Chamada de voz
                    </Box>
                  )}
                </Typography>
                {/* Unread dot */}
                {row.unanswered ? (
                  <Box
                    component="span"
                    aria-label="Não respondida"
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: "primary.main",
                      flexShrink: 0,
                    }}
                  />
                ) : null}
              </Box>

              {/* Row 3: origin, unanswered chip, and tag pills */}
              <Box
                component="span"
                sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}
              >
                <Chip
                  label={ORIGIN_LABELS[row.sourceType]}
                  size="small"
                  variant="outlined"
                  sx={{ height: 18, fontSize: 10 }}
                />
                {row.unanswered ? (
                  <Chip
                    label="Não respondida"
                    size="small"
                    sx={{ height: 18, fontSize: 10 }}
                  />
                ) : null}
                {row.tags.map((tag) => (
                  <Chip
                    key={tag.id}
                    label={tag.name}
                    size="small"
                    sx={{ height: 18, fontSize: 10, ...tagChipSx(tag.color) }}
                  />
                ))}
              </Box>
            </Box>
          </ListItemButton>
        );
      })}
    </List>
  );
}

/**
 * Center column: message history and compose rail for the selected conversation.
 * @param conversation - Selected inbox row, or null when the attendant has not picked a thread.
 * @param draft - Current compose field text.
 * @param setDraft - Updates the compose field after send or while typing.
 * @param channelQuery - Channel status query gating outbound send and WhatsApp Web fallback links.
 */
