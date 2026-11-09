/**
 * Test design (testing-strategy)
 *
 * Setup: UsuariosPage in AppProviders; MSW GET /users, GET /units, POST /users
 * and PUT /users/:id/units. Session is seeded by setupTests (Bearer on the
 * client). `seedTeam` installs the two reads every test needs, because the page
 * now fetches on mount and `onUnhandledRequest: "bypass"` would otherwise let
 * those escape to the network and land every test in the error state.
 *
 * Oracle: auth spec — `GET /users` rows carry the COMPLETE membership set;
 * `GET /units` names the caller's lojas. Portuguese Usuários create +
 * attach/detach; create hits POST /users; service-role key is not in the SPA
 * request or UsuariosPage source (API-only SUPABASE_SERVICE_ROLE_KEY).
 *
 * Axes
 *   A1 create POST — 201 / 500
 *   A2 body — email+password+name+unitIds; no service-role name
 *   A3 attach PUT — unitIds replace, reached from the row's dialog
 *   A4 team GET — pending / 500 / [] / rows
 *   A5 row membership — all named / some outside the caller's units / none
 *   A6 edit set seeded from the row — a named toggle off / a toggle on over an
 *      unnamed membership the caller never sees
 *   A7 create-form frame — the artboard's field order and label placement
 *
 * Outputs
 *   O1 "Usuário criado" + POST /users captured
 *   O2 Portuguese create error
 *   O3 PUT body unitIds, and the unnamed membership still in it
 *   O4 skeleton / Portuguese list error + Tentar de novo / empty copy / rows
 *   O5 named chips, "+N fora do seu acesso", "Nenhuma unidade"
 *   O6 optimistic row while the create is in flight, then the server row
 *   O7 no field on the screen asks for a user id or a unit id
 *   O8 each field's `label[for]` precedes its input (never MUI's floating
 *      InputLabel), in the order Nome, E-mail, Senha
 *
 * Sampled-cell
 *   create 201     | A1 201 A2 | O1 | service-role in JSON
 *   create 500     | A1 500    | O2 | success alert
 *   attach row PUT | A3 A6     | O3 | POST /users
 *   attach unnamed | A3 A6     | O3 | unit-z dropped from the PUT
 *   no identifier  | A6        | O7 | a typed id field
 *   team loading   | A4 held   | O4 | rows on screen
 *   team error     | A4 500    | O4 | rows on screen
 *   team empty     | A4 []     | O4 | table
 *   team rows      | A4 A5     | O4 O5 | a bare unit id on screen
 *   create refresh | A1 201 A4 | O6 | stale list after create
 *   form frame     | A7        | O8 | E-mail first, or a floating label
 *
 * Decision map (UsuariosPage)
 *   D1 create.isError T: 500 it; F: 201 it
 *   D2 create.isSuccess T: 201 it; F: 500 it
 *   D3 unitIds empty T: omit unitIds on create; F: not sampled (comma field)
 *   D4 attach.isError T: not sampled (same Alert pattern as create);
 *      F: both attach its
 *   D5 create.isPending T: held-request it (label + disabled); F: 201/500 its
 *   D6 team.isLoading T: held-GET it; F: every other it
 *   D7 team.isError T: 500-GET it; F: every other it
 *   D8 rows empty T: empty-list it; F: populated it
 *   D9 UnitCell hidden > 0 T: "+1 fora do seu acesso"; F: named-chips row
 *   D10 UnitCell unitIds empty T: "Nenhuma unidade"; F: named-chips row
 *   D11 UnitPicker chip on T: Norte seeded aria-pressed on Roberta's dialog;
 *       F: the same chip after the toggle click
 *   D12 hiddenForEditing > 0 T: the note on Marcelo's dialog;
 *       F: Roberta's dialog, whose whole set the caller can name
 *   D13 UnitPicker units empty T: not sampled (both fixtures name two lojas);
 *       F: every dialog and create-form it
 *
 * Out of scope: Playwright; live Auth admin.
 */
import { type TeamUser } from "@select-lub/shared-types";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "./AppProviders.js";
import { UsuariosPage } from "./UsuariosPage.js";
import { server } from "../test/msw/server.js";

const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

const UNITS = [
  { id: "unit-a", name: "Centro" },
  { id: "unit-b", name: "Norte" },
];

const TEAM: TeamUser[] = [
  {
    id: "22222222-2222-2222-2222-222222222222",
    email: "roberta.nunes@selectlub.example",
    name: "Roberta Nunes",
    unitIds: ["unit-a", "unit-b"],
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    email: "marcelo.prado@selectlub.example",
    name: "Marcelo Prado",
    // `unit-z` is a loja the caller does not hold, so `GET /units` never names
    // it — the row must count it rather than print the identifier.
    unitIds: ["unit-a", "unit-z"],
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    email: "daniela.rocha@selectlub.example",
    name: "Daniela Rocha",
    unitIds: [],
  },
];

/** Installs the two reads the page issues on mount. */
function seedTeam(users: TeamUser[] = TEAM) {
  server.use(
    http.get("*/api/users", () => HttpResponse.json(users)),
    http.get("*/api/units", () => HttpResponse.json(UNITS)),
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <UsuariosPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  seedTeam();
});

afterEach(() => {
  server.resetHandlers();
});

describe("UsuariosPage team list", () => {
  it("separates team rows with a hairline and draws none under the last", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Usuários" });
    const rows = within(table).getAllByRole("row");
    // Header rule plus one row per member: four rows, three of them people.
    expect(rows).toHaveLength(4);

    const borderOf = (row: HTMLElement) => {
      const cs = getComputedStyle(row.querySelector("th, td") as HTMLElement);
      return { width: cs.borderBottomWidth, color: cs.borderBottomColor };
    };
    // #D9D9D9, the theme's outline token. Asserted as a value rather than
    // "some border": MUI DOES draw a border here by default, but lightens the
    // divider by 88% toward white for table cells, which landed on
    // rgb(250,250,250) and read as no line at all. "Has a border" would have
    // passed on the near-invisible one this replaces.
    const OUTLINE = "rgb(217, 217, 217)";

    // The header rule and the row dividers are one treatment, not two weights.
    for (const row of rows.slice(0, 3)) {
      expect(borderOf(row)).toEqual({ width: "1px", color: OUTLINE });
    }

    // The half that would otherwise regress silently: nothing under the last
    // row, or the card gains a line floating above its own padding.
    expect(borderOf(rows[3]!).width).toBe("0px");
  });

  it("lists the team, naming units and counting the ones outside the caller's access", async () => {
    renderPage();

    const table = await screen.findByRole("table", { name: "Usuários" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);

    const roberta = within(rows[0]!);
    expect(roberta.getByText("Roberta Nunes")).toBeInTheDocument();
    expect(roberta.getByText("roberta.nunes@selectlub.example")).toBeInTheDocument();
    expect(roberta.getByText("Centro")).toBeInTheDocument();
    expect(roberta.getByText("Norte")).toBeInTheDocument();

    expect(within(rows[1]!).getByText("+1 fora do seu acesso")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Nenhuma unidade")).toBeInTheDocument();

    // The screen's promise: no identifier is ever printed in place of a name.
    expect(screen.queryByText("unit-z")).not.toBeInTheDocument();
    expect(screen.queryByText("unit-a")).not.toBeInTheDocument();
  });

  it("shows a skeleton while the team is loading", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("*/api/users", async () => {
        await held;
        return HttpResponse.json(TEAM);
      }),
    );
    renderPage();

    expect(await screen.findByRole("status", { name: "Carregando usuários" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Usuários" })).not.toBeInTheDocument();
    release();
    expect(await screen.findByText("Roberta Nunes")).toBeInTheDocument();
  });

  it("offers Tentar de novo when the team read fails, and recovers on retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get("*/api/users", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: "fail" }, { status: 500 })
          : HttpResponse.json(TEAM);
      }),
    );
    renderPage();

    expect(await screen.findByText("Não foi possível carregar os usuários")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

    expect(await screen.findByText("Roberta Nunes")).toBeInTheDocument();
  });

  it("points at the create form when nobody is on the team yet", async () => {
    seedTeam([]);
    renderPage();

    expect(await screen.findByText("Nenhum usuário cadastrado")).toBeInTheDocument();
    expect(screen.getByText("Crie o primeiro acesso no formulário abaixo.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Usuários" })).not.toBeInTheDocument();
  });

  it("shows the account being created as a dimmed row, then the server row", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed = TEAM;
    server.use(
      http.get("*/api/users", () => HttpResponse.json(listed)),
      http.post("*/api/users", async () => {
        await held;
        listed = [
          ...TEAM,
          {
            id: "55555555-5555-5555-5555-555555555555",
            email: "camila.torres@selectlub.example",
            name: "Camila Torres",
            unitIds: ["unit-a"],
          },
        ];
        return HttpResponse.json(
          {
            id: "55555555-5555-5555-5555-555555555555",
            email: "camila.torres@selectlub.example",
            name: "Camila Torres",
            unitIds: ["unit-a"],
          },
          { status: 201 },
        );
      }),
    );
    renderPage();
    await screen.findByText("Roberta Nunes");

    await user.type(screen.getAllByLabelText(/E-mail/)[0]!, "camila.torres@selectlub.example");
    await user.type(screen.getAllByLabelText(/^Senha/)[0]!, "uma-senha");
    await user.type(screen.getByLabelText(/^Nome/), "Camila Torres");
    await user.click(await screen.findByRole("button", { name: "Centro" }));
    await user.click(screen.getByRole("button", { name: "Criar usuário" }));

    const optimistic = await screen.findByText("Camila Torres");
    expect(optimistic).toBeInTheDocument();
    expect(within(optimistic.closest("tr")!).getByText("Centro")).toBeInTheDocument();

    release();
    expect(
      await screen.findByText("Usuário criado: camila.torres@selectlub.example"),
    ).toBeInTheDocument();
    // Refetched, not merely left behind by the optimistic row: the form was
    // cleared on success, so a surviving "Camila Torres" can only be the
    // server's.
    const table = await screen.findByRole("table", { name: "Usuários" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getByText("Camila Torres")).toBeInTheDocument();
  });
});

describe("UsuariosPage", () => {
  it("posts create to /users without a service-role key", async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    server.use(
      http.post("*/api/users", async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json(
          {
            id: "22222222-2222-2222-2222-222222222222",
            email: "nova@example.com",
            name: "Nova",
            unitIds: ["unit-a"],
          },
          { status: 201 },
        );
      }),
    );
    renderPage();

    await user.type(screen.getAllByLabelText(/E-mail/)[0]!, "nova@example.com");
    await user.type(screen.getAllByLabelText(/^Senha/)[0]!, "uma-senha");
    await user.type(screen.getByLabelText(/^Nome/), "Nova");
    await user.click(await screen.findByRole("button", { name: "Centro" }));
    await user.click(screen.getByRole("button", { name: "Criar usuário" }));

    expect(await screen.findByText("Usuário criado: nova@example.com")).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      email: "nova@example.com",
      password: "uma-senha",
      name: "Nova",
      unitIds: ["unit-a"],
    });
    expect(JSON.stringify(posts[0])).not.toContain(SERVICE_ROLE_ENV);
    expect(JSON.stringify(posts[0])).not.toMatch(/VITE_.*SERVICE/);
    const pageSource = readFileSync(join(import.meta.dirname, "UsuariosPage.tsx"), "utf8");
    expect(pageSource).not.toContain(SERVICE_ROLE_ENV);
    expect(pageSource).not.toMatch(/VITE_.*SERVICE/);
  });

  it("swaps the button label to Criando usuário... while the create is pending", async () => {
    // align-shipped-ui-to-canvas F13: pending branch of the label ternary.
    // Hold the POST until after the pending assertion — delay(150) finished
    // before toBeDisabled() on a loaded workspace run (same node, success re-render).
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post("*/api/users", async () => {
        await held;
        return HttpResponse.json(
          { id: "22222222-2222-2222-2222-222222222222", email: "nova@example.com", name: "Nova", unitIds: [] },
          { status: 201 },
        );
      }),
    );
    renderPage();

    await user.type(screen.getAllByLabelText(/E-mail/)[0]!, "nova@example.com");
    await user.type(screen.getAllByLabelText(/^Senha/)[0]!, "uma-senha");
    await user.type(screen.getByLabelText(/^Nome/), "Nova");
    await user.click(screen.getByRole("button", { name: "Criar usuário" }));

    expect(await screen.findByRole("button", { name: "Criando usuário..." })).toBeDisabled();
    release();
    expect(await screen.findByText("Usuário criado: nova@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar usuário" })).toBeInTheDocument();
  });

  it("shows a Portuguese error when create fails", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/api/users", () => HttpResponse.json({ error: "fail" }, { status: 500 })));
    renderPage();

    await user.type(screen.getAllByLabelText(/E-mail/)[0]!, "nova@example.com");
    await user.type(screen.getAllByLabelText(/^Senha/)[0]!, "uma-senha");
    await user.type(screen.getByLabelText(/^Nome/), "Nova");
    await user.click(screen.getByRole("button", { name: "Criar usuário" }));

    expect(await screen.findByText("Não foi possível criar o usuário")).toBeInTheDocument();
  });

  it("replaces memberships with PUT /users/:id/units, chosen from the row", async () => {
    const user = userEvent.setup();
    const puts: { url: string; body: unknown }[] = [];
    server.use(
      http.put("*/api/users/:id/units", async ({ request }) => {
        puts.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({
          id: "22222222-2222-2222-2222-222222222222",
          email: "roberta.nunes@selectlub.example",
          name: "Roberta Nunes",
          unitIds: ["unit-a"],
        });
      }),
    );
    renderPage();

    // Roberta holds Centro and Norte; the row is the only way in, and the
    // dialog opens seeded with what she already has.
    const roberta = (await screen.findByText("Roberta Nunes")).closest("tr")!;
    await user.click(within(roberta).getByRole("button", { name: "Editar unidades" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unidades — Roberta Nunes")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Norte" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(within(dialog).getByRole("button", { name: "Norte" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain("/users/22222222-2222-2222-2222-222222222222/units");
    expect(puts[0]!.body).toEqual({ unitIds: ["unit-a"] });
    expect(JSON.stringify(puts[0]!.body)).not.toContain(SERVICE_ROLE_ENV);
  });

  it("keeps memberships the caller cannot see when saving from the dialog", async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    server.use(
      http.put("*/api/users/:id/units", async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json({
          id: "33333333-3333-3333-3333-333333333333",
          email: "marcelo.prado@selectlub.example",
          name: "Marcelo Prado",
          unitIds: ["unit-a", "unit-b", "unit-z"],
        });
      }),
    );
    renderPage();

    // Marcelo is in unit-a (named Centro) and unit-z, which the caller cannot
    // name. PUT replaces the whole set, so unit-z must ride along untouched.
    const marcelo = (await screen.findByText("Marcelo Prado")).closest("tr")!;
    await user.click(within(marcelo).getByRole("button", { name: "Editar unidades" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/também está em 1 unidade fora do seu acesso/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Norte" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ unitIds: ["unit-a", "unit-z", "unit-b"] });
  });

  it("says essas unidades in the plural when the caller cannot name two or more", async () => {
    // D12/hiddenForEditing: the existing it above only ever seeded ONE hidden
    // membership (Marcelo, unit-z), so the singular "1 unidade"/"essa unidade"
    // text was the only arm of D9's two ternaries this suite had exercised.
    seedTeam([
      ...TEAM,
      {
        id: "66666666-6666-6666-6666-666666666666",
        email: "igor.bastos@selectlub.example",
        name: "Igor Bastos",
        // Neither unit-y nor unit-z is in UNITS, so both are hidden.
        unitIds: ["unit-y", "unit-z"],
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    const igor = (await screen.findByText("Igor Bastos")).closest("tr")!;
    await user.click(within(igor).getByRole("button", { name: "Editar unidades" }));
    const dialog = await screen.findByRole("dialog");

    expect(
      within(dialog).getByText(
        "Este usuário também está em 2 unidades fora do seu acesso. Salvar mantém essas unidades.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a Portuguese error when saving unit changes fails", async () => {
    // attach.isError: no prior it had driven PUT /users/:id/units to a
    // failure, so this Alert had never rendered.
    const user = userEvent.setup();
    server.use(
      http.put("*/api/users/:id/units", () =>
        HttpResponse.json({ error: "fail" }, { status: 500 }),
      ),
    );
    renderPage();

    const roberta = (await screen.findByText("Roberta Nunes")).closest("tr")!;
    await user.click(within(roberta).getByRole("button", { name: "Editar unidades" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    expect(
      await screen.findByText("Não foi possível atualizar as unidades"),
    ).toBeInTheDocument();
  });

  it("swaps Salvar to Salvando... while the unit save is pending", async () => {
    // attach.isPending: the create form's own "Criando usuário..." it above
    // covers that ternary on `create`, but `attach`'s pending label was never
    // driven — a held PUT is what puts it on screen.
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put("*/api/users/:id/units", async () => {
        await held;
        return HttpResponse.json({
          id: "22222222-2222-2222-2222-222222222222",
          email: "roberta.nunes@selectlub.example",
          name: "Roberta Nunes",
          unitIds: ["unit-a"],
        });
      }),
    );
    renderPage();

    const roberta = (await screen.findByText("Roberta Nunes")).closest("tr")!;
    await user.click(within(roberta).getByRole("button", { name: "Editar unidades" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("button", { name: "Salvando..." })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the create-form card narrower than the Equipe table, at the artboard's 560px cap", async () => {
    // auth spec, "a card no wider than roughly 560px" (design.md D10). Nothing
    // had asserted the cap itself before this it — the create-form frame it
    // below only checks field order and label placement.
    renderPage();
    await screen.findByText("Roberta Nunes");

    const submit = screen.getByRole("button", { name: "Criar usuário" });
    const form = submit.closest("form") as HTMLElement;
    expect(getComputedStyle(form).maxWidth).toBe("560px");

    // The negative half is the one that actually pins the constraint to the
    // create form: the Equipe card must NOT carry the same cap, or a build
    // that capped every card would satisfy the positive assertion alone.
    const table = screen.getByRole("table", { name: "Usuários" });
    expect(getComputedStyle(table.parentElement as HTMLElement).maxWidth).not.toBe("560px");
  });

  it("draws the create form as Nome, E-mail, Senha with each label above its input", async () => {
    // align-shipped-ui-to-pdf-artboards 5.1 / auth spec, "The create form is a
    // narrow card with labels above its fields". The artboard's order is Nome
    // first; the shipped form asked for E-mail first.
    renderPage();
    await screen.findByText("Roberta Nunes");

    const submit = screen.getByRole("button", { name: "Criar usuário" });
    const form = submit.closest("form")!;

    const fields = ["Nome", "E-mail", "Senha"].map((label) => {
      const input = within(form).getByLabelText(label);
      const labelEl = form.querySelector(`label[for="${input.id}"]`);
      return { label, input, labelEl };
    });

    for (const { label, labelEl, input } of fields) {
      expect(labelEl, `${label} has no label pointing at its input`).not.toBeNull();
      // Above the input, not floated inside its outline: the label node comes
      // first in document order and is not MUI's InputLabel.
      expect(labelEl!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(labelEl!.className).not.toContain("MuiInputLabel");
    }

    // The artboard's order, top to bottom.
    const order = fields.map(({ labelEl }) => labelEl!);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("asks for no identifier anywhere on the screen", async () => {
    renderPage();
    await screen.findByText("Roberta Nunes");

    for (const field of screen.queryAllByRole("textbox")) {
      expect(field.getAttribute("aria-label") ?? field.id).not.toMatch(/^userId$|unitIds/);
    }
    expect(screen.queryByLabelText(/ID do usuário/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/IDs das unidades/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Separados por vírgula/)).not.toBeInTheDocument();
  });
});
