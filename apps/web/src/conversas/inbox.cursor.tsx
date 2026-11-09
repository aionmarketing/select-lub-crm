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
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
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
  ORIGIN_LABELS,
  saoPauloTime,
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
  const errorRef = useRef<HTMLDivElement>(null);
  const connected = channelQuery.data?.state === "CONNECTED";
  const createMutation = useMutation({
    mutationFn: () => createConversation(phone),
    onSuccess: async (conversation) => {
      setOpen(false);
      setPhone("");
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onCreated(conversation.id);
    },
  });

  function close() {
    setOpen(false);
    setPhone("");
    createMutation.reset();
  }

  useEffect(() => {
    if (createMutation.isError) {
      errorRef.current?.focus();
    }
  }, [createMutation.isError]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!connected || !phone.trim()) {
      return;
    }
    createMutation.mutate();
  }

  return (
    <>
      <Button
        variant="contained"
        sx={{ whiteSpace: "nowrap", flexShrink: 0 }}
        onClick={() => setOpen(true)}
      >
        Nova conversa
      </Button>
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
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
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
    <Stack spacing={0.5} sx={{ mb: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: "wrap" }}
        role="group"
        aria-label="Filtrar por tags"
      >
        <Chip
          label="Todas"
          size="small"
          variant={selectedIds.length === 0 ? "filled" : "outlined"}
          color={selectedIds.length === 0 ? "primary" : "default"}
          onClick={() => onChange([])}
          aria-pressed={selectedIds.length === 0}
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
              sx={selected ? tagChipSx(tag.color) : undefined}
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
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A conversa precisa ter todas as tags selecionadas
      </Typography>
    </Stack>
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
      {query.data.map((row) => (
        <ListItemButton
          key={row.id}
          data-testid="conversas-list-item"
          data-conversation-id={row.id}
          selected={row.id === selectedId}
          onClick={() => onSelect(row.id)}
          sx={{ alignItems: "flex-start", gap: 1.5 }}
        >
          <Avatar sx={{ width: 40, height: 40, mt: 0.5 }}>
            {row.contactLabel.trim().charAt(0).toUpperCase()}
          </Avatar>
          <ListItemText
            primary={
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 1,
                }}
              >
                <Typography component="span" sx={{ fontWeight: 600 }} noWrap>
                  {row.contactLabel}
                </Typography>
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{ flexShrink: 0 }}
                >
                  {saoPauloTime.format(new Date(row.lastMessageAt))}
                </Typography>
              </Box>
            }
            secondary={
              <>
                <Typography
                  component="span"
                  variant="body2"
                  color="text.secondary"
                  sx={{ display: "block" }}
                  noWrap
                >
                  {row.lastSnippet}
                </Typography>
                <Box
                  component="span"
                  sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}
                >
                  <Chip
                    label={ORIGIN_LABELS[row.sourceType]}
                    size="small"
                    variant="outlined"
                  />
                  {row.unanswered ? <Chip label="Não respondida" size="small" /> : null}
                  {row.tags.map((tag) => (
                    <Chip
                      key={tag.id}
                      label={tag.name}
                      size="small"
                      sx={tagChipSx(tag.color)}
                    />
                  ))}
                </Box>
              </>
            }
            slotProps={{
              primary: { component: "div" },
              secondary: { component: "div" },
            }}
          />
        </ListItemButton>
      ))}
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
