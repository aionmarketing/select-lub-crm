/**
 * Attendant WhatsApp inbox — conversation list, message thread, compose, tags, and prefill rail.
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
import { ContactRail } from "./conversas/contact-rail.cursor.js";
import { OmiePendenciasPanel } from "./conversas/prefill.js";
import { useDebouncedValue } from "./conversas/helpers.js";
import {
  ChannelChip,
  ConversationList,
  NovaConversaControl,
  TagFilter,
} from "./conversas/inbox.cursor.js";
import { ThreadPane } from "./conversas/thread.js";
import { useSelection } from "./selectionStore.js";
import { ScreenNav } from "./ScreenNav.cursor.js";
import { MAIN_CONTENT_ID, TYPE_SCALE } from "./theme.js";

/**
 * Main Conversas screen at `/` for attendants handling live customer threads.
 *
 * @returns Inbox, message thread, compose bar, and contact rail (cadastro, quote, schedule, prefill).
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
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <ScreenNav current="/" />
      <Box
        component="main"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        sx={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          outline: "none",
        }}
      >
        {/* Top bar: search, unanswered toggle, nova conversa, channel state (F1/F3) */}
        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: "center",
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <TextField
            label="Buscar"
            placeholder="Nome ou telefone"
            size="small"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            sx={{ flex: 1 }}
          />
          <FormControlLabel
            sx={{ whiteSpace: "nowrap" }}
            control={
              <Switch
                size="small"
                checked={unanswered}
                onChange={(event) => setUnanswered(event.target.checked)}
              />
            }
            label="Não respondidas"
          />
          <NovaConversaControl channelQuery={channelQuery} onCreated={select} />
          <ChannelChip query={channelQuery} />
          <IconButton
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
                sx={{ display: "flex", width: 22, height: 22 }}
                aria-hidden
              >
                <svg
                  width="22"
                  height="22"
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
        </Stack>
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
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: "minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)",
            },
            flex: 1,
            minHeight: 0,
          }}
        >
          <Box
            data-testid="conversas-inbox"
            sx={{ borderRight: 1, borderColor: "divider", p: 2 }}
          >
            <Typography
              component="h1"
              sx={{ fontSize: TYPE_SCALE.page, fontWeight: 800, mb: 1 }}
            >
              Conversas
            </Typography>
            <TagFilter selectedIds={filterTagIds} onChange={setFilterTagIds} />
            {reportOrigin || reportStage || reportPeriodActive ? (
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: "wrap", mb: 1 }}
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
          <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <ThreadPane
              conversation={selected}
              draft={draft}
              setDraft={setDraft}
              channelQuery={channelQuery}
              targetMessageId={messageFromUrl}
            />
          </Box>
          <Box sx={{ borderLeft: 1, borderColor: "divider", p: 2 }}>
            <ContactRail conversation={selected} onQuoteConfirmed={setDraft} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
