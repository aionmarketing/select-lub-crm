/**
 * Admin settings screen — CRUD for conversation tags and message templates.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import type { Tag, Template } from "@select-lub/shared-types";
import {
  createTag,
  createTemplate,
  fetchTags,
  fetchTemplates,
  patchTag,
  patchTemplate,
} from "./api.js";
import { LabeledInput, LabeledSelect, MenuItem } from "./LabeledField.js";
import { PageSection, PageShell, cardSx } from "./PageShell.js";
import { tagChipSx } from "./tagChip.js";

const COLOR_OPTIONS = [
  { value: "", label: "Sem cor" },
  { value: "primary", label: "Primária" },
  { value: "secondary", label: "Secundária" },
  { value: "error", label: "Erro" },
  { value: "warning", label: "Aviso" },
  { value: "info", label: "Informação" },
] as const;

/** Side of the Cor swatch, in pixels — the artboard's square beside the name. */
const SWATCH_SIZE = 14;

/**
 * The fill the Cor swatch draws for a tag colour.
 *
 * Read off {@link tagChipSx} rather than restated as a second table, so the
 * square in the select cannot drift from the chip it is previewing — which is
 * the swatch's whole job. `tagChipSx` is declared as `SxProps<Theme>`, a union
 * that admits arrays and callbacks, so reading a property off it needs the
 * cast; every arm of that function returns a plain object with a `bgcolor`.
 *
 * @param value - A `COLOR_OPTIONS` value.
 * @returns The palette role to fill the square with.
 */
function swatchTint(value: string) {
  return (tagChipSx(value) as { bgcolor?: string }).bgcolor ?? "surfaceVariant";
}

/**
 * The colour square that precedes an option name in the Cor select.
 *
 * Decorative: the option's name is already the accessible text, so the swatch
 * is hidden from assistive tech rather than read out as a second label.
 *
 * @param value - A `COLOR_OPTIONS` value; unknown values fall back to the
 *   no-colour tint, which is what an unmapped tag chip draws too.
 * @returns The square.
 */
function ColorSwatch({ value }: { value: string }) {
  return (
    <Box
      aria-hidden="true"
      data-testid={`cor-swatch-${value || "none"}`}
      sx={{
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        flex: "none",
        borderRadius: 0.5,
        border: 1,
        borderColor: "divider",
        bgcolor: swatchTint(value),
      }}
    />
  );
}

/**
 * A template row's frame: a bordered block inside the catalog card.
 *
 * The catalog card itself is borderless on the grey ground, so the only
 * hairline on this screen is the one the artboard draws around each template
 * — it is what separates a template's name, text and actions from the next.
 */
const TEMPLATE_BLOCK_SX = {
  p: 1.5,
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
} as const;

/**
 * Settings page at `/configuracoes` for tag and template maintenance.
 *
 * @returns Tag and template catalog editors for the current unit, with loading/empty/error copy.
 */
export function ConfiguracoesPage() {
  return (
    <PageShell current="/configuracoes" title="Configurações">
      <PageSection title="Tags">
        <TagsCatalog />
      </PageSection>
      <PageSection title="Templates">
        <TemplatesCatalog />
      </PageSection>
    </PageShell>
  );
}

/** Tag list with create form and inline edit/deactivate rows, in one card. */
function TagsCatalog() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["tags"], queryFn: fetchTags });
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const create = useMutation({
    mutationFn: () =>
      createTag({
        name,
        color: color === "" ? null : (color as "primary" | "secondary" | "error" | "warning" | "info"),
      }),
    onSuccess: () => {
      setName("");
      setColor("");
      void queryClient.invalidateQueries({ queryKey: ["tags"] });
    },
  });

  return (
    <Stack sx={cardSx} spacing={2}>
      <Box
        component="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!name.trim()) {
            return;
          }
          create.mutate();
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          useFlexGap
          sx={{ alignItems: { sm: "flex-end" } }}
        >
          <LabeledInput
            id="nova-tag-nome"
            label="Nome da tag"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <LabeledSelect
            id="nova-tag-cor"
            label="Cor"
            value={color}
            onChange={(event) => setColor(event.target.value as string)}
            sx={{ minWidth: 160 }}
            // "" is a real choice here — "Sem cor" — not an absent one, so the
            // field draws it like any other. Without this MUI treats the empty
            // value as nothing to show and renders a zero-width space in place
            // of `renderValue`, which would leave the default state blank.
            displayEmpty
            // The closed select carries the swatch too, not just the open
            // menu: the reader picks a colour and then has to live with the
            // field, and a bare "Primária" there tells them nothing about
            // what the chip will look like.
            renderValue={(selected) => {
              const value = (selected as string) ?? "";
              return (
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <ColorSwatch value={value} />
                  <span>{COLOR_OPTIONS.find((o) => o.value === value)?.label ?? "Sem cor"}</span>
                </Stack>
              );
            }}
          >
            {COLOR_OPTIONS.map((option) => (
              <MenuItem key={option.value || "none"} value={option.value}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <ColorSwatch value={option.value} />
                  <span>{option.label}</span>
                </Stack>
              </MenuItem>
            ))}
          </LabeledSelect>
          <Button type="submit" variant="contained" disabled={create.isPending}>
            Criar tag
          </Button>
        </Stack>
      </Box>
      <CatalogBody
        query={query}
        empty="Nenhuma tag cadastrada"
        loading="Carregando tags"
        error="Não foi possível carregar as tags"
        separated
        renderItem={(tag: Tag) => (
          <TagRow
            tag={tag}
            onSave={(patch) => patchTag(tag.id, patch)}
            onDone={() => void queryClient.invalidateQueries({ queryKey: ["tags"] })}
          />
        )}
      />
    </Stack>
  );
}

/**
 * Single tag row with inline rename and deactivate actions.
 *
 * @param tag - Tag record from `GET /tags`.
 * @param onSave - Persists a name or active patch via `PATCH /tags/:id`.
 * @param onDone - Invalidates the tags query after a successful save.
 * @returns One catalog row with edit/deactivate controls.
 */
function TagRow({
  tag,
  onSave,
  onDone,
}: {
  tag: Tag;
  onSave: (patch: { name?: string; active?: boolean }) => Promise<unknown>;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => {
      setEditing(false);
      onDone();
    },
  });

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={1}
      sx={{ alignItems: { sm: "center" } }}
      useFlexGap
    >
      {editing ? (
        <TextField
          label="Nome da tag"
          value={name}
          onChange={(event) => setName(event.target.value)}
          size="small"
        />
      ) : (
        <Chip label={tag.name} sx={tagChipSx(tag.color)} />
      )}
      {!editing && !tag.active ? (
        <Typography variant="body2" color="text.secondary">
          Inativa
        </Typography>
      ) : null}
      {/* The artboard keeps a row's actions at the far end of its line. */}
      <Stack direction="row" spacing={1} sx={{ ml: { sm: "auto" } }}>
        {editing ? (
          <Button
            size="small"
            variant="contained"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate({ name })}
          >
            Salvar
          </Button>
        ) : (
          <Button size="small" variant="outlined" onClick={() => setEditing(true)}>
            Editar
          </Button>
        )}
        {tag.active ? (
          <Button
            size="small"
            variant="outlined"
            disabled={save.isPending}
            onClick={() => save.mutate({ active: false })}
          >
            Desativar
          </Button>
        ) : (
          <Button
            size="small"
            variant="outlined"
            disabled={save.isPending}
            onClick={() => save.mutate({ active: true })}
          >
            Reativar
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

/** Template list with create form and inline edit/deactivate rows, in one card. */
function TemplatesCatalog() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["templates"], queryFn: fetchTemplates });
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: () => createTemplate({ name, text, allowedVariables: ["nome_cliente", "placa"] }),
    onSuccess: () => {
      setName("");
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
  });

  return (
    <Stack sx={cardSx} spacing={2}>
      <Box
        component="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!name.trim() || !text.trim()) {
            return;
          }
          create.mutate();
        }}
      >
        <Stack spacing={2} sx={{ maxWidth: 560 }}>
          <LabeledInput
            id="novo-template-nome"
            label="Nome do template"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <LabeledInput
            id="novo-template-texto"
            label="Texto"
            value={text}
            onChange={(event) => setText(event.target.value)}
            required
            multiline
            minRows={3}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={create.isPending}
            sx={{ alignSelf: "flex-start" }}
          >
            Criar template
          </Button>
        </Stack>
      </Box>
      <CatalogBody
        query={query}
        empty="Nenhum template cadastrado"
        loading="Carregando templates"
        error="Não foi possível carregar os templates"
        renderItem={(template: Template) => (
          <TemplateRow
            template={template}
            onSave={(patch) => patchTemplate(template.id, patch)}
            onDone={() => void queryClient.invalidateQueries({ queryKey: ["templates"] })}
          />
        )}
      />
    </Stack>
  );
}

/**
 * Single template row with inline edit and deactivate actions.
 *
 * @param template - Template record from `GET /templates`.
 * @param onSave - Persists name, text, or status via `PATCH /templates/:id`.
 * @param onDone - Invalidates the templates query after a successful save.
 * @returns One bordered block with the template's name, text and controls.
 */
function TemplateRow({
  template,
  onSave,
  onDone,
}: {
  template: Template;
  onSave: (patch: { name?: string; text?: string; status?: "active" | "inactive" }) => Promise<unknown>;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [text, setText] = useState(template.text);
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => {
      setEditing(false);
      onDone();
    },
  });

  return (
    <Stack spacing={1} sx={{ ...TEMPLATE_BLOCK_SX, maxWidth: 560 }}>
      {editing ? (
        <>
          <TextField
            label="Nome do template"
            value={name}
            onChange={(event) => setName(event.target.value)}
            size="small"
          />
          <TextField
            label="Texto"
            value={text}
            onChange={(event) => setText(event.target.value)}
            size="small"
            multiline
          />
          <Button
            size="small"
            variant="contained"
            disabled={save.isPending || !name.trim() || !text.trim()}
            onClick={() => save.mutate({ name, text })}
            sx={{ alignSelf: "flex-start" }}
          >
            Salvar
          </Button>
        </>
      ) : (
        <>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Typography variant="subtitle2">{template.name}</Typography>
            {template.status === "active" ? null : <Chip size="small" label="Inativo" />}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {template.text}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={() => setEditing(true)}>
              Editar
            </Button>
            {template.status === "active" ? (
              <Button
                size="small"
                variant="outlined"
                disabled={save.isPending}
                onClick={() => save.mutate({ status: "inactive" })}
              >
                Desativar
              </Button>
            ) : (
              <Button
                size="small"
                variant="outlined"
                disabled={save.isPending}
                onClick={() => save.mutate({ status: "active" })}
              >
                Reativar
              </Button>
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}

/**
 * Shared loading, error, empty, and list rendering for settings catalogs.
 *
 * @param query - TanStack query supplying catalog rows.
 * @param empty - User-facing copy when the list has zero items.
 * @param loading - User-facing copy shown while the query is loading.
 * @param error - User-facing copy shown when the query fails.
 * @param separated - Draws a hairline between rows, as the tag list does.
 * @param renderItem - Renders one catalog row by id.
 * @returns Loading/error copy, empty-state text, or a stack of `renderItem` rows.
 */
function CatalogBody<T extends { id: string }>({
  query,
  empty,
  loading,
  error,
  separated,
  renderItem,
}: {
  query: { isLoading: boolean; isError: boolean; data?: T[]; refetch: () => void };
  empty: string;
  loading: string;
  error: string;
  separated?: boolean;
  renderItem: (item: T) => ReactNode;
}) {
  if (query.isLoading) {
    return (
      <Stack spacing={1} role="status">
        <Skeleton variant="rounded" height={48} />
        <Typography>{loading}</Typography>
      </Stack>
    );
  }
  if (query.isError) {
    return (
      <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
        <Alert severity="error">{error}</Alert>
        <Button variant="contained" onClick={() => void query.refetch()}>
          Tentar de novo
        </Button>
      </Stack>
    );
  }
  if (!query.data?.length) {
    return (
      <Typography color="text.secondary">{empty}</Typography>
    );
  }
  return (
    <Stack spacing={2} divider={separated ? <Divider flexItem /> : undefined}>
      {query.data.map((item) => (
        <Box key={item.id}>{renderItem(item)}</Box>
      ))}
    </Stack>
  );
}
