/**
 * Admin user provisioning — the team list, creating accounts, and attaching store units.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type TeamUser, type Unit } from "@select-lub/shared-types";
import { useState, useEffect, useRef, type FormEvent } from "react";
import { attachUserUnits, createUser, fetchUnits, fetchUsers } from "./api.js";
import { LabeledInput, FieldLabel } from "./LabeledField.js";
import { PageSection, PageShell, cardSx } from "./PageShell.js";
import { TYPE_SCALE } from "./theme.js";

/**
 * The Equipe table's column headers: caption-sized and upper-cased, as the
 * artboard draws NOME / E-MAIL / UNIDADES.
 *
 * The upper case is a CSS transform, so the written word is still what a test
 * or a screen reader reads.
 */
const HEADER_CELL_SX = {
  fontSize: TYPE_SCALE.caption,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "text.secondary",
  borderBottomColor: "divider",
} as const;

/**
 * The hairline under a team row, matching the artboard, which separates every
 * row of the table.
 *
 * MUI already draws a border here, so this is a re-colouring and not a new
 * rule: `TableCell` lightens the divider token by 88% toward white, which on
 * this theme lands at `rgb(250, 250, 250)` and reads as no line at all. The
 * header rule takes the same declaration, so the table keeps ONE hairline
 * treatment rather than gaining a second weight.
 *
 * It sits on the cell rather than on a `& td` selector from the table: a
 * descendant selector is not honoured by `getComputedStyle` under jsdom, so
 * the border would have been untestable and, worse, would have looked applied
 * while the near-white default still shipped.
 */
const BODY_CELL_SX = { borderBottomColor: "divider" } as const;

/**
 * The last row closes on the card's own padding. A rule under it would float
 * above that padding, and the artboard draws none.
 */
const LAST_BODY_CELL_SX = { borderBottom: 0 } as const;

/**
 * The unit memberships of one team row, rendered by name.
 *
 * A membership the caller cannot name is counted rather than printed: the whole
 * point of `GET /units` is to keep identifiers off this screen, and the list a
 * caller sees carries memberships in lojas they do not hold, which have no name
 * to show. Counting them still tells the operator the row is wider than it
 * looks, which matters because saving replaces the entire set.
 *
 * @param unitIds - The user's complete membership set.
 * @param names - Unit id to display name, for the lojas the caller holds.
 * @returns Named chips, a count of the unnamed rest, or the empty-state text.
 */
/**
 * Adds a unit id to a selection, or removes it when already there.
 * @param current - The selection to change.
 * @param unitId - The id the pressed chip stands for.
 * @returns A new selection; appended ids keep press order.
 */
function toggled(current: string[], unitId: string) {
  return current.includes(unitId)
    ? current.filter((id) => id !== unitId)
    : [...current, unitId];
}

function UnitCell({
  unitIds,
  names,
}: {
  unitIds: string[];
  names: Map<string, string>;
}) {
  const named = unitIds.filter((unitId) => names.has(unitId));
  const hidden = unitIds.length - named.length;

  if (unitIds.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nenhuma unidade
      </Typography>
    );
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{ flexWrap: "wrap", alignItems: "center" }}
    >
      {named.map((unitId) => (
        <Chip key={unitId} size="small" label={names.get(unitId)} />
      ))}
      {hidden > 0 ? (
        <Typography variant="caption" color="text.secondary">
          +{hidden} fora do seu acesso
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * Toggleable named chips for choosing units, in place of a typed id list.
 *
 * Only offers the caller's own lojas, which is all `GET /units` names — you
 * cannot grant access you do not hold yourself.
 *
 * @param units - The lojas to offer, each already carrying its display name.
 * @param selected - Currently chosen unit ids.
 * @param onToggle - Called with a unit id when its chip is pressed.
 * @param label - Group label announced to assistive technology.
 * @returns One chip per unit, filled while selected and outlined while not.
 */
function UnitPicker({
  units,
  selected,
  onToggle,
  label,
}: {
  units: Unit[];
  selected: string[];
  onToggle: (unitId: string) => void;
  label: string;
}) {
  if (units.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nenhuma unidade disponível
      </Typography>
    );
  }

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      role="group"
      aria-label={label}
      sx={{ flexWrap: "wrap" }}
    >
      {units.map((unit) => {
        const on = selected.includes(unit.id);
        return (
          <Chip
            key={unit.id}
            label={unit.name}
            clickable
            color={on ? "primary" : "default"}
            variant={on ? "filled" : "outlined"}
            aria-pressed={on}
            onClick={() => onToggle(unit.id)}
          />
        );
      })}
    </Stack>
  );
}

/**
 * User management page at `/usuarios` — the team list plus the create and
 * unit-assignment forms.
 *
 * @returns The team read surface with its loading, error, empty and populated
 *   states, and the admin forms for the current session.
 */
export function UsuariosPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [createUnitIds, setCreateUnitIds] = useState<string[]>([]);
  // The row whose memberships are being edited, and the set being edited.
  // `editUnitIds` starts as the row's COMPLETE set — including lojas this
  // caller cannot name — because Salvar replaces the whole set, so anything
  // dropped here is access silently revoked.
  const [editing, setEditing] = useState<TeamUser | null>(null);
  const [editUnitIds, setEditUnitIds] = useState<string[]>([]);
  const createErrorRef = useRef<HTMLDivElement>(null);
  const attachErrorRef = useRef<HTMLDivElement>(null);

  const team = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
  const units = useQuery({ queryKey: ["units"], queryFn: fetchUnits });
  const unitNames = new Map((units.data ?? []).map((unit) => [unit.id, unit.name]));

  const create = useMutation({
    mutationFn: () =>
      createUser({
        email,
        password,
        name,
        ...(createUnitIds.length > 0 ? { unitIds: createUnitIds } : {}),
      }),
    onSuccess: () => {
      setEmail("");
      setPassword("");
      setName("");
      setCreateUnitIds([]);
      // The new account belongs in the list above the form that made it, and
      // the server row is the one to trust — the optimistic row carries only
      // what the form knew.
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const attach = useMutation({
    mutationFn: (target: TeamUser) => attachUserUnits(target.id, editUnitIds),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });

  useEffect(() => {
    if (create.isError) {
      createErrorRef.current?.focus();
    }
  }, [create.isError]);

  useEffect(() => {
    if (attach.isError) {
      attachErrorRef.current?.focus();
    }
  }, [attach.isError]);

  function toggleCreateUnit(unitId: string) {
    setCreateUnitIds((current) => toggled(current, unitId));
  }

  function toggleEditUnit(unitId: string) {
    setEditUnitIds((current) => toggled(current, unitId));
  }

  function openEditor(row: TeamUser) {
    attach.reset();
    setEditing(row);
    setEditUnitIds(row.unitIds);
  }

  function onCreate(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  const rows = team.data ?? [];
  // Memberships in the dialog's edit set that `GET /units` cannot name. They
  // are carried through Salvar untouched, so the operator is told they exist
  // rather than left to read a shorter chip list as a loss.
  const hiddenForEditing = editUnitIds.filter(
    (unitId) => !unitNames.has(unitId),
  ).length;

  return (
    <>
      <PageShell current="/usuarios" title="Usuários">
        <PageSection title="Equipe">
          {team.isLoading ? (
            <Box sx={cardSx} role="status" aria-label="Carregando usuários">
              <Skeleton height={32} />
              <Skeleton height={44} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </Box>
          ) : team.isError ? (
            <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
              <Alert severity="error">Não foi possível carregar os usuários</Alert>
              <Button variant="contained" onClick={() => void team.refetch()}>
                Tentar de novo
              </Button>
            </Stack>
          ) : rows.length === 0 && !create.isPending ? (
            <Box sx={{ ...cardSx, p: 4 }}>
              <Stack spacing={1} sx={{ alignItems: "center" }}>
                <Typography sx={{ fontSize: TYPE_SCALE.subsection, fontWeight: 600 }}>
                  Nenhum usuário cadastrado
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Crie o primeiro acesso no formulário abaixo.
                </Typography>
              </Stack>
            </Box>
          ) : (
            <Box sx={cardSx}>
              <Table size="small" aria-label="Usuários">
                <TableHead>
                  <TableRow>
                    <TableCell sx={HEADER_CELL_SX}>Nome</TableCell>
                    <TableCell sx={HEADER_CELL_SX}>E-mail</TableCell>
                    <TableCell sx={HEADER_CELL_SX}>Unidades</TableCell>
                    {/* The action column carries no header, and its cells are
                        NOT right-aligned: the artboard starts the pill where
                        the column starts, immediately after Unidades, and
                        leaves the slack to its right. Right-aligning pushed it
                        to the table's far edge, away from the row it acts on —
                        the same rule the Follow-up rows follow. */}
                    <TableCell sx={HEADER_CELL_SX} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {create.isPending ? (
                    // The account the form is submitting right now, shown where
                    // it will land rather than only as a spinner on the button.
                    <TableRow sx={{ opacity: 0.6 }}>
                      <TableCell sx={BODY_CELL_SX}>{name}</TableCell>
                      <TableCell sx={BODY_CELL_SX}>{email}</TableCell>
                      <TableCell sx={BODY_CELL_SX}>
                        <UnitCell unitIds={createUnitIds} names={unitNames} />
                      </TableCell>
                      <TableCell sx={BODY_CELL_SX}>
                        <Typography variant="caption" color="text.secondary">
                          Criando…
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {rows.map((row, index) => {
                    const cellSx =
                      index === rows.length - 1 ? LAST_BODY_CELL_SX : BODY_CELL_SX;
                    return (
                      <TableRow key={row.id}>
                        <TableCell sx={cellSx}>{row.name}</TableCell>
                        <TableCell sx={cellSx}>{row.email}</TableCell>
                        <TableCell sx={cellSx}>
                          <UnitCell unitIds={row.unitIds} names={unitNames} />
                        </TableCell>
                        <TableCell sx={cellSx}>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => openEditor(row)}
                          >
                            Editar unidades
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}
        </PageSection>

        <PageSection title="Criar usuário">
          <Box component="form" onSubmit={onCreate} sx={{ ...cardSx, maxWidth: 560 }}>
            <Stack spacing={2}>
              {create.isError ? (
                <Alert ref={createErrorRef} tabIndex={-1} severity="error">
                  Não foi possível criar o usuário
                </Alert>
              ) : null}
              <LabeledInput
                id="novo-usuario-nome"
                label="Nome"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <LabeledInput
                id="novo-usuario-email"
                label="E-mail"
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <LabeledInput
                id="novo-usuario-senha"
                label="Senha"
                type="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <Stack spacing={0.5}>
                <FieldLabel>Unidades</FieldLabel>
                <UnitPicker
                  units={units.data ?? []}
                  selected={createUnitIds}
                  onToggle={toggleCreateUnit}
                  label="Unidades do novo usuário"
                />
                <Typography variant="caption" color="text.secondary">
                  Opcional. Toque para incluir ou remover. Sem unidade, o usuário entra
                  sem acesso a dados.
                </Typography>
              </Stack>
              <Button
                type="submit"
                variant="contained"
                color="primary"
                disabled={create.isPending}
                sx={{ alignSelf: "flex-start" }}
              >
                {create.isPending ? "Criando usuário..." : "Criar usuário"}
              </Button>
              {create.isSuccess ? (
                <Alert severity="success">Usuário criado: {create.data.email}</Alert>
              ) : null}
            </Stack>
          </Box>
        </PageSection>
      </PageShell>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Unidades — {editing?.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {attach.isError ? (
              <Alert ref={attachErrorRef} tabIndex={-1} severity="error">
                Não foi possível atualizar as unidades
              </Alert>
            ) : null}
            <UnitPicker
              units={units.data ?? []}
              selected={editUnitIds}
              onToggle={toggleEditUnit}
              label="Unidades do usuário"
            />
            {hiddenForEditing > 0 ? (
              <Typography variant="caption" color="text.secondary">
                Este usuário também está em {hiddenForEditing}{" "}
                {hiddenForEditing === 1 ? "unidade" : "unidades"} fora do seu acesso.
                Salvar mantém
                {hiddenForEditing === 1 ? " essa unidade" : " essas unidades"}.
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>Cancelar</Button>
          <Button
            variant="contained"
            disabled={attach.isPending}
            onClick={() => editing && attach.mutate(editing)}
          >
            {attach.isPending ? "Salvando..." : "Salvar"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
