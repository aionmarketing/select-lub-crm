/**
 * Attendant WhatsApp inbox — conversation list, message thread, compose, tags, and prefill rail.
 *
 * Layout (WhatsApp Web–inspired):
 *   [icon-rail (56 px)] | [inbox panel (~320 px)] | [thread (flex-1)] | [contact rail (~320 px)]
 *
 * Every column is independently scrollable and fills the height left below the
 * app bar, so the overall page does not scroll — only the column whose content
 * overflows scrolls. The wrapper is `100dvh` MINUS {@link SHELL_BAR_HEIGHT_PX}
 * (falling back to `100vh`): it renders below `RequireAuth`'s AppBar, so a full
 * viewport height here made the document exactly one bar taller than the
 * viewport and every antigravity route scrolled by 52px.
 *
 * The subtraction is deliberate rather than `flex: 1` on a `minHeight: 100vh`
 * parent. `flex` only distributes FREE space, so that parent grows with the
 * content instead of constraining it; measured, the inbox column then rendered
 * 4640px tall inside a clipped shell and the last conversation was unreachable.
 * The columns below rely on this element having a definite height.
 * The ScreenNav icon rail lives inside the inbox column so the left edge is seamless.
 */
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ConversationPipelineStage,
  ConversationSourceType,
} from "@select-lub/shared-types";
import { fetchChannelStatus, fetchConversations, fetchGlobalPendings } from "./api.js";
import {
  formatPeriodChip,
  ORIGIN_LABELS,
  THREAD_STAGE_LABELS,
} from "./conversas/inboxLink.js";
import { ContactRail } from "./conversas/contact-rail.antigravity.js";
import { OmiePendenciasPanel } from "./conversas/prefill.js";
import { useDebouncedValue } from "./conversas/helpers.js";
import {
  ChannelChip,
  ConversationList,
  NovaConversaControl,
  TagFilter,
} from "./conversas/inbox.antigravity.js";
import { ThreadPane } from "./conversas/thread.js";
import { MAIN_CONTENT_ID, shellBelowBarSx } from "./theme.js";
import { useSelection } from "./selectionStore.js";
import { ScreenNav } from "./ScreenNav.antigravity.js";

/**
 * Main Conversas screen at `/` for attendants handling live customer threads.
 *
 * @returns Full-height three-column layout: inbox, message thread, and contact rail,
 *   each independently scrollable, with a WhatsApp-style left icon rail for navigation.
 */
export function ConversasPage() {
  const selectedConversationId = useSelection((state) => state.selectedConversationId);
  const select = useSelection((state) => state.select);
  const [searchParams] = useSearchParams();
  const conversationFromUrl = searchParams.get("conversation");
  const messageFromUrl = searchParams.get("message");
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [unanswered, setUnanswered] = useState(false);
  // Read once, the same way conversationFromUrl is: a report link SETS the
  // cut the inbox opens on, and each chip clears its own piece from here —
  // the URL itself is not kept in sync afterward.
  const [reportOrigin, setReportOrigin] = useState(
    searchParams.get("origin") ?? undefined,
  );
  const [reportStage, setReportStage] = useState(
    searchParams.get("stage") ?? undefined,
  );
  const [reportFrom] = useState(searchParams.get("from") ?? undefined);
  const [reportTo] = useState(searchParams.get("to") ?? undefined);
  const reportPeriodActive = reportFrom !== undefined && reportTo !== undefined;
  const [draft, setDraft] = useState("");
  const [omiePanelOpen, setOmiePanelOpen] = useState(false);
  const channelQuery = useQuery({
    queryKey: ["channel-status"],
    queryFn: fetchChannelStatus,
    refetchInterval: 3_000,
  });
  const listQuery = useQuery({
    queryKey: [
      "conversations",
      filterTagIds,
      debouncedSearch,
      unanswered,
      reportOrigin,
      reportStage,
      reportFrom,
      reportTo,
    ],
    queryFn: () =>
      fetchConversations({
        tagIds: filterTagIds,
        q: debouncedSearch,
        unanswered,
        origin: reportOrigin,
        stage: reportStage,
        from: reportFrom,
        to: reportTo,
      }),
    refetchInterval: 3_000,
  });
  const selected =
    listQuery.data?.find((row) => row.id === selectedConversationId) ?? null;
  const pendingsQuery = useQuery({
    queryKey: ["reconciliation-pendings"],
    queryFn: fetchGlobalPendings,
    refetchInterval: 3_000,
  });
  const pendingCount = pendingsQuery.data?.length ?? 0;

  useEffect(() => {
    setDraft("");
  }, [selectedConversationId]);

  useEffect(() => {
    if (conversationFromUrl) {
      select(conversationFromUrl);
    }
  }, [conversationFromUrl, select]);

  return (
    // Viewport minus the app bar — the app does NOT scroll vertically as a
    // whole. See the module comment for why the bar is subtracted.
    <Box
      sx={{
        display: "flex",
        flexDirection: "row",
        ...shellBelowBarSx,
        overflow: "hidden",
      }}
    >
      {/* Left icon rail — navigation between all six screens */}
      <ScreenNav current="/" />

      {/* Inbox panel: fixed ~320px, internally scrollable */}
      <Box
        data-testid="conversas-inbox"
        sx={{
          width: { xs: "100%", md: 320 },
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          overflow: "hidden",
        }}
      >
        {/* ── Inbox top bar: search + nova conversa ── */}
        <Box
          sx={{
            px: 1.5,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
            bgcolor: "surfaceVariant",
            flexShrink: 0,
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
            <Typography
              component="h1"
              variant="h6"
              sx={{ fontWeight: 700, fontSize: "16px", flexShrink: 0 }}
            >
              Conversas
            </Typography>
            {/* Channel status + Omie pendencies badge */}
            <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
              <ChannelChip query={channelQuery} />
              <IconButton
                size="small"
                aria-label={
                  pendingCount > 0
                    ? `Pendências com o Omie, ${pendingCount}`
                    : "Pendências com o Omie"
                }
                onClick={() => setOmiePanelOpen(true)}
              >
                <Badge
                  badgeContent={pendingCount}
                  color="error"
                  invisible={pendingCount === 0}
                  overlap="circular"
                >
                  <Box
                    component="span"
                    sx={{ display: "flex", width: 20, height: 20 }}
                    aria-hidden
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                  </Box>
                </Badge>
              </IconButton>
            </Box>
          </Stack>

          {/* Search bar + Nova Conversa (WhatsApp-style) */}
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <TextField
              label="Buscar"
              placeholder="Buscar conversa…"
              size="small"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <Box
                      component="span"
                      sx={{ display: "flex", mr: 0.5, color: "text.disabled" }}
                      aria-hidden
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    </Box>
                  ),
                },
              }}
              sx={{
                flex: 1,
                "& .MuiOutlinedInput-root": {
                  borderRadius: "20px",
                  bgcolor: "background.paper",
                },
              }}
            />
            {/* Nova conversa — primary-coloured icon button (replaces the full-width "Nova conversa" button) */}
            <NovaConversaControl channelQuery={channelQuery} onCreated={select} />
          </Stack>
        </Box>

        {/* ── Tag filter chips (horizontal scroll, no wrap) ── */}
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: 1,
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          <TagFilter selectedIds={filterTagIds} onChange={setFilterTagIds} />
          {/* Unanswered toggle */}
          <FormControlLabel
            sx={{ mt: 0.5, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
            control={
              <Switch
                size="small"
                checked={unanswered}
                onChange={(event) => setUnanswered(event.target.checked)}
              />
            }
            label="Não respondidas"
          />
        </Box>

        {/* ── Report drill-through filter chips ── */}
        {reportOrigin || reportStage || reportPeriodActive ? (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              flexWrap: "wrap",
              px: 1.5,
              py: 0.75,
              borderBottom: 1,
              borderColor: "divider",
              flexShrink: 0,
            }}
            aria-label="Filtros do relatório"
          >
            {reportStage ? (
              <Chip
                size="small"
                label={`Etapa: ${THREAD_STAGE_LABELS[reportStage as ConversationPipelineStage] ?? reportStage}`}
                onDelete={() => setReportStage(undefined)}
                deleteIcon={
                  <Box
                    component="svg"
                    role="button"
                    aria-label="Remover filtro de etapa"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </Box>
                }
              />
            ) : null}
            {reportOrigin ? (
              <Chip
                size="small"
                label={`Origem: ${ORIGIN_LABELS[reportOrigin as ConversationSourceType] ?? reportOrigin}`}
                onDelete={() => setReportOrigin(undefined)}
                deleteIcon={
                  <Box
                    component="svg"
                    role="button"
                    aria-label="Remover filtro de origem"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </Box>
                }
              />
            ) : null}
            {reportPeriodActive ? (
              <Chip size="small" label={formatPeriodChip(reportFrom!, reportTo!)} />
            ) : null}
          </Stack>
        ) : null}

        {/* ── Conversation list — fills remaining height and scrolls independently ── */}
        <Box sx={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          <ConversationList
            query={listQuery}
            selectedId={selectedConversationId}
            onSelect={select}
            searchQuery={debouncedSearch}
            unansweredFilter={unanswered}
            reportFilterActive={Boolean(
              reportOrigin || reportStage || reportPeriodActive,
            )}
          />
        </Box>
      </Box>

      {/* Omie pendencies drawer */}
      <Drawer
        anchor="right"
        open={omiePanelOpen}
        onClose={() => setOmiePanelOpen(false)}
        slotProps={{
          paper: { "aria-label": "Pendências com o Omie — todos os clientes" },
        }}
      >
        <OmiePendenciasPanel
          rows={pendingsQuery.data ?? []}
          conversations={listQuery.data ?? []}
          onOpenConversation={(id) => {
            select(id);
            setOmiePanelOpen(false);
          }}
          onClose={() => setOmiePanelOpen(false)}
        />
      </Drawer>

      {/* Thread pane — flex-1, independently scrollable, and the skip link's
          target: it is the first thing past the icon rail and the inbox that an
          attendant actually came here to read. */}
      <Box
        component="main"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          overflow: "hidden",
          outline: "none",
        }}
      >
        <ThreadPane
          conversation={selected}
          draft={draft}
          setDraft={setDraft}
          channelQuery={channelQuery}
          targetMessageId={messageFromUrl}
        />
      </Box>

      {/* Contact / profile rail — fixed 350px, padded, independently scrollable */}
      <Box
        sx={{
          width: { xs: 0, lg: 350 },
          flexShrink: 0,
          borderLeft: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          p: 2,
          overflowY: "auto",
          overflowX: "hidden",
          display: { xs: "none", lg: "block" },
        }}
      >
        <ContactRail conversation={selected} onQuoteConfirmed={setDraft} />
      </Box>
    </Box>
  );
}
