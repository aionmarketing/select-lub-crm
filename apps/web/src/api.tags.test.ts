/**
 * Test design (testing-strategy)
 *
 * Setup: fetchTags / createTag / previewTemplate against MSW.
 *
 * Oracle: shared Tag/Template write contract + preview { text }.
 *
 * Axes
 *   A1 HTTP ok vs 500
 *   A2 list query tagId repeat
 *   A3 preview body text
 *
 * Outputs: O1 parsed Tag/text; O2 throw
 *
 * Sampled-cell
 *   fetchTags fixture     | A1 ok  | O1 | throw
 *   createTag 500         | A1 500 | O2 | parses
 *   fetchConversations two tagIds | A2 | — | URL missing second tagId
 *   preview text          | A3     | O1 | throw
 *
 * Decision map (api/tags.ts parse; api/conversations.ts tagIds loop)
 *   D1 parse() !ok T: 500; F: 200 tests
 *   D2 tagIds loop T: two ids; F: fetchConversations() default []
 *
 * Out of scope: Configurações UI (ConfiguracoesPage.test.tsx).
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { createTag, fetchConversations, fetchTags, previewTemplate } from "./api.js";
import { server } from "../test/msw/server.js";

afterEach(() => {
  server.resetHandlers();
});

describe("tags API client", () => {
  it("parses a tag list", async () => {
    server.use(
      http.get("*/api/tags", () =>
        HttpResponse.json([
          { id: "tag-1", name: "Retorno", color: "primary", sortOrder: 0, active: true },
        ]),
      ),
    );
    const rows = await fetchTags();
    expect(rows).toEqual([
      { id: "tag-1", name: "Retorno", color: "primary", sortOrder: 0, active: true },
    ]);
  });

  it("throws when createTag is not ok", async () => {
    server.use(http.post("*/api/tags", () => HttpResponse.json({ error: "fail" }, { status: 500 })));
    await expect(createTag({ name: "Retorno" })).rejects.toThrow(/http 500/);
  });

  it("repeats tagId on the conversation list query", async () => {
    const ids: string[][] = [];
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        ids.push(new URL(request.url).searchParams.getAll("tagId"));
        return HttpResponse.json([]);
      }),
    );
    await fetchConversations({ tagIds: ["tag-1", "tag-2"] });
    expect(ids[0]).toEqual(["tag-1", "tag-2"]);
  });

  it("returns preview text", async () => {
    server.use(
      http.post("*/api/conversations/:id/templates/:templateId/preview", () =>
        HttpResponse.json({ text: "Ola Ana" }),
      ),
    );
    await expect(previewTemplate("conv-1", "tpl-1")).resolves.toBe("Ola Ana");
  });
});
