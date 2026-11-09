/**
 * Test design (testing-strategy)
 *
 * Setup: ConfiguracoesPage in AppProviders; shared MSW. Query retry: false.
 *
 * Oracle: tags-templates — Portuguese empty/loading/error catalogs; create
 * then list with optional color; patch rename, deactivate and reactivate;
 * inactive row stays listed with Inativa/Inativo (apply-options hide is API,
 * not this screen). Each catalog is ONE card holding its create form above its
 * rows, with the form's labels above its inputs. Theme hexes stay in
 * no-hex.test.ts.
 *
 * Axes
 *   A1 catalog GET — [] / hang / 500 / 200 with rows
 *   A2 create POST — 201 name+color / whitespace no POST
 *   A3 patch — rename / deactivate / reactivate / already inactive
 *   A4 catalog frame — form and rows in one card, label above the input
 *
 * Outputs
 *   O1 empty copy
 *   O2 loading copy
 *   O3 error + Tentar de novo
 *   O4 created name/color visible
 *   O5 edited name visible
 *   O6 Inativa / Inativo
 *   O7 the row and the create form share one card; `label[for]` precedes the
 *      input and is not MUI's floating InputLabel
 *   O8 Reativar patches the row back on and gives the row Desativar again
 *
 * Sampled-cell
 *   empty catalogs     | A1 []     | O1 | invented "Novo lead"
 *   loading            | A1 hang   | O2 | empty first
 *   tags GET 500       | A1 500    | O3 | empty copy
 *   templates GET 500  | A1 500    | O3 | empty copy
 *   create tag+color   | A2 201    | O4 | still empty / color omitted
 *   whitespace create  | A2 skip   | O1 | POST fired
 *   create template    | A2 201    | O4 | still empty
 *   edit tag           | A3 rename | O5 | old name remains
 *   deactivate tag     | A3 off    | O6 | row erased
 *   inactive tag row   | A3 listed | O6 | Desativar still shown
 *   edit template      | A3 rename | O5 | old text remains
 *   deactivate tpl     | A3 off    | O6 | row erased
 *   one card per cat.  | A1 A4     | O7 | form and rows on separate surfaces
 *   reactivate tag     | A3 on     | O8 | the row stuck as Inativa
 *   reactivate tpl     | A3 on     | O8 | the row stuck as Inativo
 *
 * Decision map (ConfiguracoesPage)
 *   D1 CatalogBody isLoading T: loading it; F: empty/error/list
 *   D2 CatalogBody isError T: 500 its; F: empty/create
 *   D3 !data.length T: empty; F: create/edit its
 *   D4 create tag !name.trim T: whitespace it; F: create appears
 *   D5 color === "" T: default create; F: Primária create
 *   D6 TagRow editing T: edit it; F: listed chip
 *   D7 tag.active T: Desativar; F: Inativa + Reativar
 *   D8 create template !name||!text T: whitespace it; F: create template
 *   D9 TemplateRow editing T: edit it; F: listed name
 *   D10 template.status==="active" T: Desativar; F: Inativo chip + Reativar
 *   D11 CatalogBody separated T: the tag list's hairlines; F: the template list
 *
 * Out of scope: Playwright; hex walk (no-hex.test.ts); apply-options API.
 *
 * Infeasible (repo-foundation, "Reachable production decisions have both test
 *   outcomes" — named here rather than left one-sided), added 2026-09-07:
 *   - `swatchTint`'s `?? "surfaceVariant"`: `tagChipSx`'s own default arm
 *     (tagChip.ts) already returns a `bgcolor` for every color it does not
 *     recognise, including `null` and any unmapped string, so the cast this
 *     reads from can never itself omit `bgcolor` — the fallback has no input
 *     that reaches it.
 *   - The Cor `renderValue`'s `(selected as string) ?? ""`: `selected` is this
 *     component's own `color` state, which starts at `""` and is only ever
 *     set by clicking a `COLOR_OPTIONS` chip — never to `null` or `undefined`.
 *   - The same `renderValue`'s `.find(...)?.label ?? "Sem cor"`: reachable only
 *     if `value` matched none of `COLOR_OPTIONS`, but `value` is always either
 *     `""` or one of that same array's own values, by the same state
 *     constraint above.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Tag, Template } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConfiguracoesPage } from "./ConfiguracoesPage.js";
import { server } from "../test/msw/server.js";

function tagRow(partial: Partial<Tag> & Pick<Tag, "id" | "name">): Tag {
  return {
    color: "primary",
    sortOrder: 0,
    active: true,
    ...partial,
  };
}

function templateRow(partial: Partial<Template> & Pick<Template, "id" | "name" | "text">): Template {
  return {
    allowedVariables: ["nome_cliente", "placa"],
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ConfiguracoesPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => {
  server.resetHandlers();
});

describe("ConfiguracoesPage", () => {
  it("shows empty catalog copy for tags and templates", async () => {
    renderPage();

    expect(await screen.findByText("Nenhuma tag cadastrada")).toBeInTheDocument();
    expect(screen.getByText("Nenhum template cadastrado")).toBeInTheDocument();
    expect(screen.queryByText("Novo lead")).not.toBeInTheDocument();
  });

  it("shows Portuguese loading copy for both catalogs", async () => {
    server.use(
      http.get("*/api/tags", async () => {
        await delay("infinite");
        return HttpResponse.json([]);
      }),
      http.get("*/api/templates", async () => {
        await delay("infinite");
        return HttpResponse.json([]);
      }),
    );
    renderPage();

    expect(await screen.findByText("Carregando tags")).toBeInTheDocument();
    expect(screen.getByText("Carregando templates")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma tag cadastrada")).not.toBeInTheDocument();
  });

  it("shows a Portuguese error when tags fail to load", async () => {
    server.use(http.get("*/api/tags", () => HttpResponse.json({ error: "fail" }, { status: 500 })));
    renderPage();

    expect(await screen.findByText("Não foi possível carregar as tags")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("lists a tag after create", async () => {
    const user = userEvent.setup();
    let tags: Array<{ id: string; name: string; color: string | null; sortOrder: number; active: boolean }> = [];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json(tags)),
      http.post("*/api/tags", async ({ request }) => {
        const body = (await request.json()) as { name: string; color: Tag["color"] };
        const row = {
          id: "tag-new",
          name: body.name,
          color: body.color,
          sortOrder: 0,
          active: true,
        };
        tags = [row];
        return HttpResponse.json(row, { status: 201 });
      }),
    );
    renderPage();
    await screen.findByText("Nenhuma tag cadastrada");

    await user.type(screen.getByRole("textbox", { name: /Nome da tag/ }), "Retorno");
    await user.click(screen.getByRole("button", { name: "Criar tag" }));

    await waitFor(() => {
      expect(screen.getByText("Retorno")).toBeInTheDocument();
    });
    expect(screen.queryByText("Nenhuma tag cadastrada")).not.toBeInTheDocument();
  });

  it("shows a Portuguese error when templates fail to load", async () => {
    server.use(http.get("*/api/templates", () => HttpResponse.json({ error: "fail" }, { status: 500 })));
    renderPage();

    expect(await screen.findByText("Não foi possível carregar os templates")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Tentar de novo" }).length).toBeGreaterThanOrEqual(1);
  });

  it("lists a tag created with the Primária color", async () => {
    const user = userEvent.setup();
    let tags: Tag[] = [];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json(tags)),
      http.post("*/api/tags", async ({ request }) => {
        const body = (await request.json()) as { name: string; color: Tag["color"] };
        const row = tagRow({ id: "tag-color", name: body.name, color: body.color });
        tags = [row];
        return HttpResponse.json(row, { status: 201 });
      }),
    );
    renderPage();
    await screen.findByText("Nenhuma tag cadastrada");

    await user.type(screen.getByRole("textbox", { name: /Nome da tag/ }), "Retorno");
    await user.click(screen.getByLabelText("Cor"));
    await user.click(await screen.findByRole("option", { name: "Primária" }));
    await user.click(screen.getByRole("button", { name: "Criar tag" }));

    expect(await screen.findByText("Retorno")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma tag cadastrada")).not.toBeInTheDocument();
  });

  it("shows the chosen colour as a swatch in the closed Cor select", async () => {
    // The artboard draws a square in the tint the tag will actually carry
    // before the option name, in the closed field as well as in the menu:
    // "Primária" on its own says nothing about what the chip will look like.
    // The swatch is aria-hidden, so the option's accessible name stays the
    // bare label and the queries above keep resolving it.
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Nenhuma tag cadastrada");

    const select = screen.getByLabelText("Cor");
    // Closed and untouched, the field is "Sem cor" and carries its swatch.
    expect(within(select).getByTestId("cor-swatch-none")).toBeInTheDocument();

    await user.click(select);
    const option = await screen.findByRole("option", { name: "Primária" });
    expect(within(option).getByTestId("cor-swatch-primary")).toBeInTheDocument();
    await user.click(option);

    // The closed field now carries the chosen colour's swatch, not the
    // no-colour one it started with.
    expect(within(select).getByTestId("cor-swatch-primary")).toBeInTheDocument();
    expect(within(select).queryByTestId("cor-swatch-none")).toBeNull();
    expect(within(select).getByText("Primária")).toBeInTheDocument();
  });

  it("gives every Cor option a tint of its own, none shared with another", async () => {
    // A tint shared between two of the six makes those two tags
    // indistinguishable — in this swatch and, because both read the same
    // `tagChipSx`, on the chip itself. Telling tags apart by colour is the
    // whole point of having the colour, so a collision is a defect and this
    // is what catches it.
    //
    // The screen was shipped with two such collisions: warning borrowed the
    // primary container and info the secondary one, back when five tag names
    // shared three container pairs. Both now have their own, so the assertion
    // is pairwise distinctness across all six rather than a list of the
    // specific pairs that once collided — a seventh colour is then covered
    // without editing this it.
    //
    // The swatch needs no mapping of its own to stay honest: it reads its fill
    // through `tagChipSx`, so it cannot drift from the chip it previews.
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Nenhuma tag cadastrada");

    await user.click(screen.getByLabelText("Cor"));
    const fill = (name: string) =>
      getComputedStyle(
        within(screen.getByRole("option", { name })).getByTestId(/^cor-swatch-/),
      ).backgroundColor;

    const options = ["Sem cor", "Primária", "Secundária", "Erro", "Aviso", "Informação"];
    const fills = new Map(options.map((name) => [name, fill(name)]));
    // Every square resolves to a real colour: an unresolved palette role would
    // come back empty or transparent and would otherwise pass the pairwise
    // check by being equally broken everywhere.
    for (const [name, value] of fills) {
      expect(value, `${name} has no resolved fill`).not.toBe("");
      expect(value, `${name} is transparent`).not.toBe("rgba(0, 0, 0, 0)");
    }
    // Pairwise distinct, reported by name so a failure says which two collided
    // rather than only that the count was short.
    for (const [a, b] of options.flatMap((x, i) => options.slice(i + 1).map((y) => [x, y]))) {
      expect(fills.get(a as string), `${a} and ${b} share a tint`).not.toBe(fills.get(b as string));
    }
  });

  it("does not create a tag from a whitespace-only name", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      http.post("*/api/tags", () => {
        posts += 1;
        return HttpResponse.json({ error: "should-not-post" }, { status: 500 });
      }),
    );
    renderPage();
    await screen.findByText("Nenhuma tag cadastrada");

    await user.type(screen.getByRole("textbox", { name: /Nome da tag/ }), "   ");
    await user.click(screen.getByRole("button", { name: "Criar tag" }));

    expect(posts).toBe(0);
    expect(screen.getByText("Nenhuma tag cadastrada")).toBeInTheDocument();
  });

  it("renames a tag from the inline editor", async () => {
    const user = userEvent.setup();
    let tags: Tag[] = [tagRow({ id: "tag-1", name: "Retorno" })];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json(tags)),
      http.patch("*/api/tags/:id", async ({ request }) => {
        const body = (await request.json()) as { name?: string };
        tags = [{ ...tags[0]!, name: body.name ?? tags[0]!.name }];
        return HttpResponse.json(tags[0]);
      }),
    );
    renderPage();
    expect(await screen.findByText("Retorno")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    const nameField = screen.getByDisplayValue("Retorno");
    await user.clear(nameField);
    await user.type(nameField, "Orçamento");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Orçamento")).toBeInTheDocument();
    expect(screen.queryByText("Retorno")).not.toBeInTheDocument();
  });

  it("deactivates a tag and keeps the row as Inativa", async () => {
    const user = userEvent.setup();
    let tags: Tag[] = [tagRow({ id: "tag-1", name: "Retorno" })];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json(tags)),
      http.patch("*/api/tags/:id", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        tags = [{ ...tags[0]!, active: body.active ?? tags[0]!.active }];
        return HttpResponse.json(tags[0]);
      }),
    );
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Desativar" }));

    expect(await screen.findByText("Inativa")).toBeInTheDocument();
    expect(screen.getByText("Retorno")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desativar" })).not.toBeInTheDocument();
  });

  it("shows Inativa on a tag that is already inactive", async () => {
    server.use(
      http.get("*/api/tags", () => HttpResponse.json([tagRow({ id: "tag-off", name: "Arquivada", active: false })])),
    );
    renderPage();

    expect(await screen.findByText("Arquivada")).toBeInTheDocument();
    expect(screen.getByText("Inativa")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desativar" })).not.toBeInTheDocument();
  });

  it("keeps one card per catalog, holding the create form above its rows", async () => {
    // align-shipped-ui-to-pdf-artboards 5.2 / tags-templates spec, "A catalog
    // is one card under its heading": the form and the rows are not two
    // separate surfaces any more, and the form's labels sit above its inputs.
    server.use(
      http.get("*/api/tags", () => HttpResponse.json([tagRow({ id: "tag-1", name: "Retorno" })])),
    );
    renderPage();

    const region = screen.getByRole("region", { name: "Tags" });
    const nameField = within(region).getByRole("textbox", { name: /Nome da tag/ });
    const card = nameField.closest("form")!.parentElement!;

    // The row lives in the same card as the form that creates rows.
    expect(card).toContainElement(await within(region).findByText("Retorno"));
    expect(card).toContainElement(within(region).getByRole("button", { name: "Criar tag" }));

    // Label above the input, not floated inside its outline.
    const label = card.querySelector(`label[for="${nameField.id}"]`);
    expect(label).not.toBeNull();
    expect(label!.className).not.toContain("MuiInputLabel");
    expect(label!.compareDocumentPosition(nameField) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("reactivates a tag from its row", async () => {
    const user = userEvent.setup();
    let tags: Tag[] = [tagRow({ id: "tag-off", name: "Arquivada", active: false })];
    const patches: unknown[] = [];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json(tags)),
      http.patch("*/api/tags/:id", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        patches.push(body);
        tags = [{ ...tags[0]!, active: body.active ?? tags[0]!.active }];
        return HttpResponse.json(tags[0]);
      }),
    );
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Reativar" }));

    expect(await screen.findByRole("button", { name: "Desativar" })).toBeInTheDocument();
    expect(patches).toEqual([{ active: true }]);
    expect(screen.queryByText("Inativa")).not.toBeInTheDocument();
  });

  it("lists a template after create", async () => {
    const user = userEvent.setup();
    let templates: Template[] = [];
    server.use(
      http.get("*/api/templates", () => HttpResponse.json(templates)),
      http.post("*/api/templates", async ({ request }) => {
        const body = (await request.json()) as { name: string; text: string };
        const row = templateRow({ id: "tpl-new", name: body.name, text: body.text });
        templates = [row];
        return HttpResponse.json(row, { status: 201 });
      }),
    );
    renderPage();
    await screen.findByText("Nenhum template cadastrado");

    await user.type(screen.getByRole("textbox", { name: /Nome do template/ }), "Retorno");
    await user.type(screen.getByRole("textbox", { name: /^Texto$/ }), "Ola cliente");
    await user.click(screen.getByRole("button", { name: "Criar template" }));

    expect(await screen.findByText("Ola cliente")).toBeInTheDocument();
    expect(screen.getByText("Retorno")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum template cadastrado")).not.toBeInTheDocument();
  });

  it("does not create a template from whitespace-only fields", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      http.post("*/api/templates", () => {
        posts += 1;
        return HttpResponse.json({ error: "should-not-post" }, { status: 500 });
      }),
    );
    renderPage();
    await screen.findByText("Nenhum template cadastrado");

    await user.type(screen.getByRole("textbox", { name: /Nome do template/ }), "   ");
    await user.type(screen.getByRole("textbox", { name: /^Texto$/ }), "   ");
    await user.click(screen.getByRole("button", { name: "Criar template" }));

    expect(posts).toBe(0);
    expect(screen.getByText("Nenhum template cadastrado")).toBeInTheDocument();
  });

  it("renames a template from the inline editor", async () => {
    const user = userEvent.setup();
    let templates: Template[] = [templateRow({ id: "tpl-1", name: "Retorno", text: "Ola {{nome_cliente}}" })];
    server.use(
      http.get("*/api/templates", () => HttpResponse.json(templates)),
      http.patch("*/api/templates/:id", async ({ request }) => {
        const body = (await request.json()) as { name?: string; text?: string };
        templates = [
          {
            ...templates[0]!,
            name: body.name ?? templates[0]!.name,
            text: body.text ?? templates[0]!.text,
          },
        ];
        return HttpResponse.json(templates[0]);
      }),
    );
    renderPage();
    expect(await screen.findByText("Ola {{nome_cliente}}")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    const nameField = screen.getByDisplayValue("Retorno");
    await user.clear(nameField);
    await user.type(nameField, "Agradecimento");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Agradecimento")).toBeInTheDocument();
    expect(screen.queryByText("Retorno")).not.toBeInTheDocument();
  });

  it("deactivates a template and keeps the row as Inativo", async () => {
    const user = userEvent.setup();
    let templates: Template[] = [templateRow({ id: "tpl-1", name: "Retorno", text: "Ola {{nome_cliente}}" })];
    server.use(
      http.get("*/api/templates", () => HttpResponse.json(templates)),
      http.patch("*/api/templates/:id", async ({ request }) => {
        const body = (await request.json()) as { status?: "active" | "inactive" };
        templates = [{ ...templates[0]!, status: body.status ?? templates[0]!.status }];
        return HttpResponse.json(templates[0]);
      }),
    );
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Desativar" }));

    expect(await screen.findByText("Inativo")).toBeInTheDocument();
    expect(screen.getByText("Retorno")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desativar" })).not.toBeInTheDocument();
  });

  it("reactivates a template from its row", async () => {
    const user = userEvent.setup();
    let templates: Template[] = [
      templateRow({ id: "tpl-off", name: "Boas-vindas", text: "Ola!", status: "inactive" }),
    ];
    const patches: unknown[] = [];
    server.use(
      http.get("*/api/templates", () => HttpResponse.json(templates)),
      http.patch("*/api/templates/:id", async ({ request }) => {
        const body = (await request.json()) as { status?: "active" | "inactive" };
        patches.push(body);
        templates = [{ ...templates[0]!, status: body.status ?? templates[0]!.status }];
        return HttpResponse.json(templates[0]);
      }),
    );
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Reativar" }));

    expect(await screen.findByRole("button", { name: "Desativar" })).toBeInTheDocument();
    expect(patches).toEqual([{ status: "active" }]);
    expect(screen.queryByText("Inativo")).not.toBeInTheDocument();
  });
});
