/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage / App inside AppProviders. HTTP is MSW
 * (intercepts fetch; no vi.stubGlobal("fetch")).
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md + design-system
 * "WhatsApp green is not general success"):
 *   List/thread empty, error, and rows. Send goes through the outbox.
 *   Channel down is not faked as sent. Thread order is WhatsApp time.
 *   Enviar uses the WhatsApp token, not MUI success.
 *
 * Partitions (one numbered group = screen/HTTP states the spec treats
 * the same. Each INVALID group has its own `it` unless noted.):
 *
 *   P1 VALID   — gallery title string "Select Lub CRM"
 *   P2 VALID   — gallery at /galeria: heading, CTAs, Nome, Placa
 *   P3 VALID   — list empty: empty-inbox copy
 *   P4 INVALID — list HTTP 500: Portuguese error + retry
 *   P5 VALID   — message body as text, including HTML-looking strings
 *   P6 VALID   — unsupported media: unknown type → unsupported copy
 *                 (image is no longer this partition; see P21)
 *   P7 INVALID — tags: [] must not invent "Novo lead"
 *   P8 INVALID — channel disconnected: no POST, Portuguese reason
 *   P9 INVALID — composer "" or "   ": no POST
 *   P10 VALID  — thread: loading, then Portuguese error + retry, then rows
 *   P11 VALID  — shuffled providerTimestamp → DOM order is WhatsApp time
 *   P12 VALID  — two civil days in America/Sao_Paulo → two date separators
 *   P13 VALID  — contactLabel "Maria Silva" when the API sends a name
 *   P14 VALID  — send: non-empty + connected + idle → one POST, composer cleared
 *   P15 INVALID — second click while POST in flight → still one POST
 *   P16 VALID  — Enviar uses MuiButton-colorWhatsapp, not colorSuccess
 *   P17 INVALID — send POST 500: Portuguese send error, reply not shown as sent
 *   P18 VALID  — list isLoading skeleton before rows
 *   P19 VALID  — no conversation selected → "Selecione uma conversa"
 *   P20 VALID  — applied tag name is visible; empty tags still no "Novo lead"
 *
 *   P21 VALID  — inbound image + media GET 200 → img, not unsupported
 *   P22 INVALID — media GET 502 HTML payload → unavailable + retry; no img/script
 *   P23 VALID  — attach image + confirm → one POST to /messages/media, composer cleared
 *                 (jsdom fetch+FormData omits multipart Content-Type, so this
 *                 file does not parse form fields; API inject covers those)
 *   P24 INVALID — accepted image larger than 16 MiB → size copy, no media POST
 *                 (must match the file input accept list; a .bin is skipped)
 *   P25 VALID  — list lastSnippet [Imagem] is visible on the row
 *
 *   Axis 5 — ContactRail vehicles (design.md + conversas delta)
 *   P26 VALID  — two vehicles, one plated → plate + "Sem placa"
 *   P27 VALID  — add on one-car customer → dialog, Salvar veículo POSTs /vehicles,
 *                 no /messages POST (WhatsApp outbox)
 *   P28 INVALID — unresolved (customerId null) → empty-no-customer copy,
 *                 no add, no invented plates / "Sem placa"
 *   P29 VALID  — resolved zero vehicles → empty-zero-vehicles copy + add
 *   P30 INVALID — vehicles GET 500 after loading → Portuguese error + retry
 *
 *   Axis 5b — ContactRail prefill (assistive-cadastro-prefill design Axis 5)
 *   P31 VALID  — pending plate labelled confirmation, not a saved vehicle plate
 *   P32 VALID  — empty prefill does not invent name / taxId / vehicle
 *   P33 INVALID — failed extract → Portuguese error + retry POST
 *   P34 VALID  — Aceitar veículo sugerido hits POST /prefill/accept
 *   P35 INVALID — no IA-composed WhatsApp reply control
 *   P36 VALID  — Recusar veículo sugerido hits POST /prefill/reject
 *   P37 VALID  — pending with zero keys uses empty copy
 *   P38 INVALID — prefill GET 500 → same error UI as status failed
 *   P39 VALID  — accepting a year-only suggestion posts year as a number
 *   P40 VALID  — accepting an odometer-only suggestion posts km as a number
 *   P41 VALID  — outbound ticks: sent single / delivered double /
 *                read double #1565C0; confirmed-without-status no tick
 *                (message-status-ticks-ui; oracle: conversas spec
 *                "Thread shows outbound delivery status")
 *   P42 VALID  — failed shows "Não entregue"; contentUnavailable shows
 *                "Mensagem indisponível" and never the old body
 *
 * Output partitions:
 *   O1 — gallery / list / thread happy UI (P1/P2/P3/P5/P6/P11/P12/P13/P19/P20/P21/P25)
 *   O2 — Portuguese error + retry (P4/P10/P22/P30)
 *   O3 — no POST (P8/P9/P15/P24)
 *   O4 — one POST, composer empty (P14/P23)
 *   O5 — WhatsApp button class (P16)
 *   O6 — send error, not shown as sent (P17)
 *   O7 — list skeleton (P18)
 *   O8 — rail vehicle list (P26/P27)
 *   O9 — rail empty-no-customer, no add (P28)
 *   O10 — rail empty-zero-vehicles + add (P29)
 *   O11 — rail loading copy (P30 in-flight)
 *   O12 — prefill pending confirmation (P31)
 *   O13 — prefill empty copy (P32)
 *   O14 — prefill error + retry POST (P33)
 *   O15 — prefill accept POST (P34)
 *   O16 — no IA reply control (P35)
 *   O17 — prefill reject POST (P36)
 *   O18 — pending zero keys empty copy (P37)
 *   O19 — prefill GET 500 error (P38)
 *   O20 — year/odometer accept body (P39/P40)
 *
 * Limits (boundary value analysis):
 *   Composer: "" / "   " → no POST; one non-space character → POST.
 *   Dates: 25 Aug 15:00Z vs 26 Aug 15:00Z in America/Sao_Paulo
 *   (two WhatsApp times on different civil days).
 *   Vehicle count on the rail: 0 (resolved) vs 1 vs 2; unresolved is not
 *   a count, it is customerId null (P28 vs P29).
 *
 * Send decision table (empty? × channel up? × already in flight? × POST ok?):
 *   1 empty + connected + idle → P9, no POST
 *   2 text + disconnected + idle → P8, no POST
 *   3 text + connected + idle + 201 → P14, one POST
 *   4 text + connected + in flight → P15, still one POST
 *   5 text + connected + idle + 500 → P17, one POST, error
 *   6 attached image + connected + idle + 201 → P23, one /messages/media POST
 *   7 attached image size MEDIA_MAX_BYTES+1 → P24, no POST
 *
 * Rail empty decision (customerId set? × vehicles.length):
 *   1 customerId null → P28, no add (vehicles[] ignored)
 *   2 customerId set + length 0 → P29, add visible
 *   3 customerId set + length 2, one plate → P26
 *
 * ConversasPage.tsx leftover: outbound vs inbound align is CSS (ml auto);
 * both directions are rendered (P5 markup it inbound, send success outbound
 * after POST). `?conversation=` T: Follow-up link it; F: P19 none open.
 * pendingCount > 0 T/F: ConversasPage.cadastro.test.tsx badge. fileInputRef
 * value clear is React ref contract-hidden. Non-empty attach caption is
 * api.send.test.ts (jsdom FormData fields unread in P23). App.tsx is a
 * router with no production `if`.
 *
 * Map from each `it` to a partition:
 *
 *   exposes the product title — P1
 *   renders the living token gallery at /galeria — P2
 *   shows empty inbox copy — P3
 *   shows an error and retries the list — P4
 *   renders markup as text, unsupported media copy, and no invented tags
 *     — P5 + P6 + P7 in one `it` (one thread payload)
 *   does not POST when the channel is down — P8
 *   does not POST an empty body — P9
 *   shows thread loading then Portuguese error and retry — P10
 *   orders the thread by providerTimestamp, not payload order — P11
 *   shows America/Sao_Paulo date separators for two civil days — P12
 *   shows a known contact name as the list label — P13
 *   queues one POST on successful send and clears the composer — P14
 *     (idempotencyKey is a UUID; scheduled-messages 2.4)
 *   does not POST twice while a send is in flight — P15
 *   uses the WhatsApp theme token on the send control, not success — P16
 *   shows a Portuguese send error and does not claim WhatsApp sent — P17
 *   shows a list loading skeleton — P18
 *   asks to select a conversation when none is open — P19
 *   opens the thread from /?conversation= (Follow-up link) — P19 F
 *   shows an applied tag without inventing others — P20
 *   renders a fetched image instead of the unsupported placeholder — P21
 *   shows unavailable retry and does not execute HTML from a failed media GET — P22
 *   queues one media POST on attach+confirm and clears the composer — P23
 *   rejects an oversized attachment with no media POST — P24
 *   shows [Imagem] on the list row when the API sends that snippet — P25
 *   lists two vehicles with a plate and a no-plate label — P26
 *   adds a vehicle via conversation POST without WhatsApp — P27
 *   hides add and invents no plates when no customer is resolved — P28
 *   shows add when the customer has zero vehicles — P29
 *   shows vehicle-list loading then Portuguese error and retry — P30
 *   shows a pending plate as confirmation, not a saved vehicle plate — P31
 *   empty prefill does not invent name, tax id, or vehicle values — P32
 *   shows prefill error and retries via POST — P33
 *   accept click posts /prefill/accept — P34
 *   reject click posts /prefill/reject — P36
 *   pending with zero keys uses empty copy — P37
 *   prefill GET 500 shows extract error — P38
 *   renders distinct delivery ticks with a blue read — P41
 *   labels failed and unavailable outbound messages — P42
 *   accepting a year-only suggestion posts a number — P39
 *   accepting an odometer-only suggestion posts a number — P40
 *   contact rail has no suggested WhatsApp reply control — P35
 *
 * Decision map (ContactRail)
 *   D1 conversation null          T: P19 rail absent; F: heading Veículos
 *   D2 isLoading                  T: P30 loading copy; F: settled
 *   D3 isError                    T: P30 error+retry; F: data
 *   D4 customerId == null         T: P28; F: P26/P27/P29
 *   D5 vehicles.length === 0      T: P29; F: P26/P27
 *   D6 plate ?? "Sem placa"       plate: P26 plated row; null: P26 unplated
 *   D7 add mutate                 T: P27 POST /vehicles; F: P28 no control
 *   D8 prefill isLoading/extracting T: Extraindo cadastro; F: settled
 *   D9 prefill isError/failed     T: P33 failed, P38 GET 500; F: pending/empty
 *   D10 prefill pending keys      T: P31/P34; F: P32 empty / P37 pending zero keys
 *   D10b prefillEntries !fields   T: pending without fields object; F: fields {}
 *   D10c prefillEntries value undefined — infeasible after JSON (undefined keys omitted)
 *   D11 acceptBodyFor year        T: P39; F: plate string (P34)
 *   D12 acceptBodyFor odometerKm  T: P40; F: plate string (P34)
 *   D13 Recusar click             T: P36
 *
 * Sampled-cell (Axis 5)
 *   two cars one plate     | D4 F D5 F D6 both | O8  | invented extra plate
 *   add via the dialog     | D7 T              | O8 + no messages POST | POST on the rail control
 *   unresolved             | D4 T              | O9  | add visible
 *   zero vehicles          | D4 F D5 T         | O10 | no add
 *   load fail + retry      | D2 T then D3 T→F  | O11 then O2 then O8 | stays error
 *   pending plate          | D10 T             | O12 ghost row, not a saved plate | Sem placa / vehicles plate
 *   empty prefill          | D10 F             | O13                 | invented Nome/CPF/placa
 *   failed + retry POST    | D9 T              | O14                 | no POST
 *   accept the vehicle     | D10 T accept      | O15                 | /messages POST
 *   reject the vehicle     | D13 T             | O17                 | /messages POST
 *   pending zero keys      | D10 F             | O18                 | Aceitar visible
 *   GET 500                | D9 isError T      | O19                 | pending copy
 *   accept a year-only sug | D11 T             | O20 year number     | string year
 *   accept an odometer sug | D12 T             | O20 km number       | string km
 *
 * Note (tasks 7.1/7.2): the suggestion cases target the rail's ghost VEHICLE
 * row, because vehicle-shaped prefill keys are now one row with a single
 * accept and a single reject rather than a per-field card — a year-only or
 * odometer-only suggestion is still a one-key vehicle, which is why those two
 * cases still assert a single-entry accept body. Adicionar veículo opens a
 * dialog, so the POST is asserted after Salvar veículo.
 *   no IA reply            | rail shown        | O16                 | suggested-reply control
 *
 * Fails if: Enviar using MuiButton-colorSuccess; thread DOM order matching
 * shuffled payload order; send 500 rendering the reply as sent; add enqueueing
 * /messages; unresolved showing Adicionar veículo.
 *
 * Out of scope: Playwright; 320px wrapping; a live WhatsApp number;
 * storing a WhatsApp display name in Postgres (ConversationRow has no
 * name column — phone-only API path is conversations.test.ts);
 * addVehicle.isPending true (in-flight disable; timing only);
 * POST 409 on unresolved from the rail (control is hidden, P28);
 * busy true (in-flight disable; timing only);
 * live OpenAI extract.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  MEDIA_MAX_BYTES,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationVehicles,
  type PrefillFieldKey,
  type PrefillSuggestion,
  type Vehicle,
} from "@select-lub/shared-types";
import { App, appTitle } from "./App.js";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

function renderGallery() {
  return render(
    <MemoryRouter initialEntries={["/galeria"]}>
      <AppProviders>
        <App />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("App gallery", () => {
  it("exposes the product title", () => {
    expect(appTitle).toBe("Select Lub CRM");
  });

  it("renders Relatórios at /relatorios and keeps Conversas at /", async () => {
    const relatorios = render(
      <MemoryRouter initialEntries={["/relatorios"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Relatórios" })).toBeInTheDocument();
    relatorios.unmount();

    const servicos = render(
      <MemoryRouter initialEntries={["/servicos"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Serviços" })).toBeInTheDocument();
    servicos.unmount();

    const followUp = render(
      <MemoryRouter initialEntries={["/follow-up"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Follow-up" })).toBeInTheDocument();
    followUp.unmount();

    const conversas = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    conversas.unmount();
  });

  it("renders the living token gallery at /galeria", () => {
    renderGallery();

    expect(screen.getByRole("heading", { name: appTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ação principal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orçamento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar no WhatsApp" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cartão de exemplo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nome")).toBeInTheDocument();
    expect(screen.getByLabelText("Placa")).toBeInTheDocument();
    expect(screen.getByText("Placa inválida")).toBeInTheDocument();
  });
});

const conversation: ConversationSummary = {
  id: "conv-1",
  contactLabel: "11988887777",
  phone: "11988887777",
  lastSnippet: "oi",
  lastMessageAt: "2026-08-26T12:00:00.000Z",
  tags: [],
  sourceType: "UNKNOWN",
  unanswered: false,
  // Inbound-only fixture, so the first stage is the truthful value.
  pipelineStage: "novosContatos",
};

const inboundOi: ConversationMessage = {
  id: "m1",
  direction: "inbound",
  messageType: "text",
  textBody: "oi",
  providerTimestamp: "2026-08-26T12:00:00.000Z",
};

function vehicleRow(partial: Partial<Vehicle> & Pick<Vehicle, "id" | "plate">): Vehicle {
  return {
    customerId: "cus-rail",
    omieId: null,
    make: null,
    model: null,
    version: null,
    year: null,
    odometerKm: null,
    origin: "crm",
    plateSourcedKeys: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

const platedVehicle = vehicleRow({ id: "veh-rail-1", plate: "ABC1D23" });
const unplatedVehicle = vehicleRow({
  id: "veh-rail-2",
  plate: null,
  createdAt: "2026-08-02T00:00:00.000Z",
});
const twoVehicles: ConversationVehicles = {
  customerId: "cus-rail",
  vehicles: [platedVehicle, unplatedVehicle],
};

function stubConversas(options: {
  list?: ConversationSummary[] | "error" | "slow";
  messages?: ConversationMessage[] | "error" | "slow-error-then-ok";
  vehicles?: ConversationVehicles | "error" | "slow" | "slow-error-then-ok";
  prefill?: (Omit<PrefillSuggestion, "extractEnabled"> & { extractEnabled?: boolean }) | "error" | "extracting";
  connected?: boolean;
  onPost?: (info: { text: string }) => ConversationMessage | Promise<ConversationMessage>;
  postDelayMs?: number;
  postStatus?: number;
  media?: "ok" | "error-html";
}) {
  let messageGets = 0;
  let vehicleGets = 0;
  const posts: string[] = [];
  const postKeys: string[] = [];
  const mediaPosts: string[] = [];
  const vehiclePosts: string[] = [];
  const acceptPosts: unknown[] = [];
  const acceptAllPosts: string[] = [];
  const rejectPosts: unknown[] = [];
  const retryPosts: string[] = [];
  let prefillGets = 0;
  const vehicleState: ConversationVehicles =
    typeof options.vehicles === "object"
      ? { customerId: options.vehicles.customerId, vehicles: [...options.vehicles.vehicles] }
      : { customerId: null, vehicles: [] };
  let prefillState: PrefillSuggestion =
    typeof options.prefill === "object"
      ? { ...options.prefill, extractEnabled: options.prefill.extractEnabled ?? false }
      : { status: "empty", extractEnabled: false };
  server.use(
    http.get("*/api/conversations/:id/prefill", async () => {
      prefillGets += 1;
      if (options.prefill === "extracting") {
        await delay(80);
        return HttpResponse.json({ status: "extracting", extractEnabled: false });
      }
      if (options.prefill === "error") {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }
      return HttpResponse.json(prefillState);
    }),
    http.post("*/api/conversations/:id/prefill/accept", async ({ request }) => {
      const body = await request.json();
      acceptPosts.push(body);
      prefillState = { status: "empty", extractEnabled: prefillState.extractEnabled };
      return HttpResponse.json(prefillState);
    }),
    http.post("*/api/conversations/:id/prefill/accept-all", () => {
      acceptAllPosts.push("all");
      prefillState = { status: "empty", extractEnabled: prefillState.extractEnabled };
      return HttpResponse.json(prefillState);
    }),
    http.post("*/api/conversations/:id/prefill/reject", async ({ request }) => {
      const body = (await request.json()) as { field: PrefillFieldKey };
      rejectPosts.push(body);
      if (prefillState.status === "pending" && prefillState.fields) {
        const next = { ...prefillState.fields };
        delete next[body.field];
        prefillState =
          Object.keys(next).length > 0
            ? { status: "pending", fields: next, extractEnabled: prefillState.extractEnabled }
            : { status: "empty", extractEnabled: prefillState.extractEnabled };
      }
      return HttpResponse.json(prefillState);
    }),
    http.post("*/api/conversations/:id/prefill/retry", () => {
      retryPosts.push("retry");
      prefillState = { status: "extracting", extractEnabled: prefillState.extractEnabled };
      return HttpResponse.json(prefillState);
    }),
    http.get("*/api/conversations/:id/vehicles", async () => {
      vehicleGets += 1;
      if (options.vehicles === "slow") {
        await delay(80);
        return HttpResponse.json(vehicleState);
      }
      if (options.vehicles === "slow-error-then-ok") {
        if (vehicleGets === 1) {
          await delay(80);
          return HttpResponse.json({ error: "fail" }, { status: 500 });
        }
        return HttpResponse.json(twoVehicles);
      }
      if (options.vehicles === "error") {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }
      return HttpResponse.json(vehicleState);
    }),
    http.get("*/api/conversations/:id/services", () =>
      HttpResponse.json({ customerId: vehicleState.customerId, services: [] }),
    ),
    http.post("*/api/conversations/:id/vehicles", () => {
      vehiclePosts.push("vehicle");
      const created = vehicleRow({
        id: `veh-added-${vehiclePosts.length}`,
        customerId: vehicleState.customerId ?? "cus-rail",
        plate: null,
        createdAt: "2026-08-03T00:00:00.000Z",
      });
      if (vehicleState.customerId) {
        vehicleState.vehicles.push(created);
      }
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get("*/api/conversations/:id/messages/:messageId/media", () => {
      if (options.media === "ok") {
        return new HttpResponse(new Uint8Array([0x47, 0x49, 0x46]), {
          headers: { "Content-Type": "image/gif" },
        });
      }
      if (options.media === "error-html") {
        return new HttpResponse("<img src=x onerror=alert(1)><script>alert(1)</script>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      return HttpResponse.json({ code: "media_unavailable" }, { status: 502 });
    }),
    // jsdom fetch+FormData omits multipart Content-Type, so request.formData()
    // throws. Field-level multipart checks live in the API inject suite.
    http.post("*/api/conversations/:id/messages/media", () => {
      mediaPosts.push("media");
      return HttpResponse.json(
        {
          id: `media-out-${mediaPosts.length}`,
          direction: "outbound",
          messageType: "image",
          textBody: null,
          providerTimestamp: "2026-08-26T12:01:00.000Z",
          outboxStatus: "queued",
        } satisfies ConversationMessage,
        { status: 201 },
      );
    }),
    http.get("*/api/conversations/:id/messages", async () => {
      messageGets += 1;
      if (options.messages === "slow-error-then-ok") {
        if (messageGets === 1) {
          await delay(80);
          return HttpResponse.json({ error: "fail" }, { status: 500 });
        }
        return HttpResponse.json([inboundOi]);
      }
      if (options.messages === "error") {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }
      return HttpResponse.json(options.messages ?? []);
    }),
    http.get("*/api/conversations", async () => {
      if (options.list === "slow") {
        await delay(80);
        return HttpResponse.json([]);
      }
      if (options.list === "error") {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }
      return HttpResponse.json(options.list ?? []);
    }),
    http.get("*/api/channel/status", () =>
      HttpResponse.json({ state: options.connected === false ? "DISCONNECTED" : "CONNECTED" }),
    ),
    http.post("*/api/conversations/:id/messages", async ({ request }) => {
      if (options.postDelayMs) {
        await delay(options.postDelayMs);
      }
      const body = (await request.json()) as { text: string; idempotencyKey?: string };
      posts.push(body.text);
      if (body.idempotencyKey) {
        postKeys.push(body.idempotencyKey);
      }
      if (options.postStatus && options.postStatus >= 400) {
        return HttpResponse.json({ error: "fail" }, { status: options.postStatus });
      }
      const queued =
        (await options.onPost?.({ text: body.text })) ??
        ({
          id: `out-${posts.length}`,
          direction: "outbound",
          messageType: "text",
          textBody: body.text,
          providerTimestamp: "2026-08-26T12:01:00.000Z",
          outboxStatus: "queued",
        } satisfies ConversationMessage);
      return HttpResponse.json(queued, { status: 201 });
    }),
  );
  return {
    posts: () => posts,
    postKeys: () => postKeys,
    messageGets: () => messageGets,
    mediaPosts: () => mediaPosts,
    vehiclePosts: () => vehiclePosts,
    acceptPosts: () => acceptPosts,
    acceptAllPosts: () => acceptAllPosts,
    rejectPosts: () => rejectPosts,
    retryPosts: () => retryPosts,
    prefillGets: () => prefillGets,
  };
}

function renderConversas(client?: QueryClient, path = "/") {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders queryClient={queryClient}>
        <ConversasPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("Conversas", () => {
  beforeEach(() => {
    useSelection.setState({ selectedConversationId: null });
  });

  afterEach(() => {
    useSelection.setState({ selectedConversationId: null });
  });

  it("shows empty inbox copy", async () => {
    stubConversas({ list: [] });
    renderConversas();
    expect(await screen.findByText("Nenhuma conversa")).toBeInTheDocument();
    expect(screen.queryByText("Novo lead")).not.toBeInTheDocument();
  });

  it("shows an error and retries the list", async () => {
    let listGets = 0;
    server.use(
      http.get("*/api/conversations/:id/messages", () => HttpResponse.json([])),
      http.get("*/api/conversations", () => {
        listGets += 1;
        if (listGets < 2) {
          return HttpResponse.json({ error: "fail" }, { status: 500 });
        }
        return HttpResponse.json([]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("Não foi possível carregar as conversas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Nenhuma conversa")).toBeInTheDocument();
  });

  it("renders markup as text, unsupported media copy, and no invented tags", async () => {
    const markup = "<img src=x onerror=alert(1)><script>alert(1)</script>";
    const messages: ConversationMessage[] = [
      {
        id: "m1",
        direction: "inbound",
        messageType: "text",
        textBody: markup,
        providerTimestamp: "2026-08-25T15:00:00.000Z",
      },
      {
        id: "m2",
        direction: "inbound",
        messageType: "unknown",
        textBody: null,
        providerTimestamp: "2026-08-26T15:00:00.000Z",
      },
    ];
    stubConversas({
      list: [{ ...conversation, lastSnippet: markup }],
      messages,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    // align-shipped-ui-to-canvas F5: the list row now renders the snippet as
    // its own text node, so the markup can match the row before the thread
    // loads — await the thread's placeholder instead of asserting it sync.
    expect(await screen.findByText("Mídia não suportada nesta versão")).toBeInTheDocument();
    expect(screen.getAllByText(markup).length).toBeGreaterThan(0);
    expect(screen.queryByText("Novo lead")).not.toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not POST when the channel is down", async () => {
    const { posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: false,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByText(/Envio pelo CRM indisponível/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir no WhatsApp" })).toHaveAttribute(
      "href",
      "https://web.whatsapp.com/send?phone=11988887777",
    );
    // align-shipped-ui-to-canvas F8: the blocked bar replaces the compose
    // controls entirely — sending is structurally impossible, not disabled.
    expect(screen.queryByLabelText("Mensagem")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
    expect(posts()).toEqual([]);
    expect(screen.queryByText("nao enviar")).not.toBeInTheDocument();
  });

  it("does not POST an empty body", async () => {
    const { posts } = stubConversas({
      list: [conversation],
      messages: [],
      connected: true,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enviar" })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(posts()).toEqual([]);
  });

  it("shows thread loading then Portuguese error and retry", async () => {
    stubConversas({
      list: [conversation],
      messages: "slow-error-then-ok",
    });
    const { container } = renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await waitFor(() => {
      expect(container.querySelector(".MuiSkeleton-root")).not.toBeNull();
    });
    expect(await screen.findByText("Não foi possível carregar as mensagens")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("oi")).toBeInTheDocument();
  });

  it("orders the thread by providerTimestamp, not payload order", async () => {
    stubConversas({
      list: [conversation],
      messages: [
        {
          id: "later",
          direction: "inbound",
          messageType: "text",
          textBody: "depois",
          providerTimestamp: "2026-08-26T18:00:00.000Z",
        },
        {
          id: "earlier",
          direction: "inbound",
          messageType: "text",
          textBody: "antes",
          providerTimestamp: "2026-08-26T12:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    const antes = await screen.findByText("antes");
    const depois = screen.getByText("depois");
    expect(antes.compareDocumentPosition(depois) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders distinct delivery ticks with a blue read on outbound bubbles", async () => {
    // message-status-ticks-ui: sent = single check, delivered = double,
    // read = double in the hand-set readTick blue #1565C0. A confirmed
    // outbox item without providerStatus must show no tick at all.
    stubConversas({
      list: [conversation],
      messages: [
        {
          id: "ms",
          direction: "outbound",
          messageType: "text",
          textBody: "enviada",
          providerTimestamp: "2026-08-26T12:01:00.000Z",
          providerStatus: "sent",
        },
        {
          id: "md",
          direction: "outbound",
          messageType: "text",
          textBody: "entregue",
          providerTimestamp: "2026-08-26T12:02:00.000Z",
          providerStatus: "delivered",
        },
        {
          id: "mr",
          direction: "outbound",
          messageType: "text",
          textBody: "lida",
          providerTimestamp: "2026-08-26T12:03:00.000Z",
          providerStatus: "read",
        },
        {
          id: "mc",
          direction: "outbound",
          messageType: "text",
          textBody: "confirmada sem status",
          providerTimestamp: "2026-08-26T12:04:00.000Z",
          outboxStatus: "confirmed",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    const sent = await screen.findByTestId("tick-sent");
    const delivered = screen.getByTestId("tick-delivered");
    const read = screen.getByTestId("tick-read");
    expect(sent.querySelectorAll("path")).toHaveLength(1);
    expect(delivered.querySelectorAll("path")).toHaveLength(2);
    expect(read.querySelectorAll("path")).toHaveLength(2);
    expect(read.querySelector("path")).toHaveAttribute("stroke", "#1565C0");
    expect(delivered.querySelector("path")).not.toHaveAttribute("stroke", "#1565C0");
    expect(screen.getAllByTestId(/^tick-/)).toHaveLength(3);
    expect(screen.getByText(/confirmed/)).toBeInTheDocument();
  });

  it("labels failed and unavailable outbound messages in Portuguese", async () => {
    stubConversas({
      list: [conversation],
      messages: [
        {
          id: "mf",
          direction: "outbound",
          messageType: "text",
          textBody: "falhou",
          providerTimestamp: "2026-08-26T12:05:00.000Z",
          providerStatus: "failed",
        },
        {
          id: "mu",
          direction: "outbound",
          messageType: "text",
          textBody: "corpo antigo apagado",
          providerTimestamp: "2026-08-26T12:06:00.000Z",
          providerStatus: "read",
          contentUnavailable: true,
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByText("Não entregue")).toBeInTheDocument();
    expect(screen.queryByTestId("tick-failed")).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem indisponível")).toBeInTheDocument();
    expect(screen.queryByText("corpo antigo apagado")).not.toBeInTheDocument();
  });

  it("shows America/Sao_Paulo date separators for two civil days", async () => {
    stubConversas({
      list: [conversation],
      messages: [
        {
          id: "d1",
          direction: "inbound",
          messageType: "text",
          textBody: "segunda",
          providerTimestamp: "2026-08-25T15:00:00.000Z",
        },
        {
          id: "d2",
          direction: "inbound",
          messageType: "text",
          textBody: "terca",
          providerTimestamp: "2026-08-26T15:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    const saoPauloDate = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "long",
    });
    expect(
      await screen.findByText(saoPauloDate.format(new Date("2026-08-25T15:00:00.000Z"))),
    ).toBeInTheDocument();
    expect(screen.getByText(saoPauloDate.format(new Date("2026-08-26T15:00:00.000Z")))).toBeInTheDocument();
  });

  it("shows a known contact name as the list label", async () => {
    stubConversas({
      list: [{ ...conversation, contactLabel: "Maria Silva" }],
      messages: [],
    });
    renderConversas();
    expect(await screen.findByRole("button", { name: /Maria Silva/ })).toBeInTheDocument();
  });

  it("queues one POST on successful send and clears the composer", async () => {
    const user = userEvent.setup();
    const { posts, postKeys } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    const field = await screen.findByLabelText("Mensagem");
    await user.type(field, "resposta");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => {
      expect(posts()).toEqual(["resposta"]);
    });
    expect(postKeys()).toHaveLength(1);
    expect(postKeys()[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(screen.getByLabelText("Mensagem")).toHaveValue("");
  });

  it("does not POST twice while a send is in flight", async () => {
    const user = userEvent.setup();
    const { posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
      postDelayMs: 200,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.type(await screen.findByLabelText("Mensagem"), "x");
    const send = screen.getByRole("button", { name: "Enviar" });
    await user.click(send);
    fireEvent.click(send);
    await waitFor(() => {
      expect(posts()).toEqual(["x"]);
    });
  });

  it("uses the WhatsApp theme token on the send control, not success", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    const send = await screen.findByRole("button", { name: "Enviar" });
    expect(send.className).toMatch(/MuiButton-colorWhatsapp/);
    expect(send.className).not.toMatch(/MuiButton-colorSuccess/);
  });

  it("shows a Portuguese send error and does not claim the reply was sent", async () => {
    const user = userEvent.setup();
    const { posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
      postStatus: 500,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.type(await screen.findByLabelText("Mensagem"), "falhou");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Não foi possível enviar a mensagem")).toBeInTheDocument();
    expect(posts()).toEqual(["falhou"]);
    expect(screen.getByLabelText("Mensagem")).toHaveValue("falhou");
    expect(screen.queryByText("queued")).not.toBeInTheDocument();
    // F5: "oi" now appears standalone on the list row too — assert presence, not uniqueness.
    expect(screen.getAllByText("oi").length).toBeGreaterThan(0);
  });

  it("shows a list loading skeleton before conversations arrive", async () => {
    stubConversas({ list: "slow" });
    const { container } = renderConversas();
    await waitFor(() => {
      expect(container.querySelector(".MuiSkeleton-root")).not.toBeNull();
    });
    expect(await screen.findByText("Nenhuma conversa")).toBeInTheDocument();
  });

  it("asks to select a conversation when none is open", async () => {
    stubConversas({ list: [conversation], messages: [] });
    renderConversas();
    expect(await screen.findByRole("button", { name: /11988887777/ })).toBeInTheDocument();
    expect(screen.getByText("Selecione uma conversa")).toBeInTheDocument();
  });

  it("opens the thread when the location has a Follow-up conversation query", async () => {
    stubConversas({ list: [conversation], messages: [inboundOi] });
    renderConversas(undefined, `/?conversation=${conversation.id}`);
    expect(await screen.findByLabelText("Mensagem")).toBeInTheDocument();
    expect(screen.queryByText("Selecione uma conversa")).not.toBeInTheDocument();
  });

  it("shows an applied tag without inventing others", async () => {
    stubConversas({
      list: [{ ...conversation, tags: [{ id: "tag-1", name: "Orçamento", color: null }] }],
      messages: [inboundOi],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findAllByText("Orçamento")).not.toHaveLength(0);
    expect(screen.queryByText("Novo lead")).not.toBeInTheDocument();
  });

  it("renders a fetched image instead of the unsupported placeholder", async () => {
    stubConversas({
      list: [conversation],
      media: "ok",
      messages: [
        {
          id: "img-1",
          direction: "inbound",
          messageType: "image",
          textBody: null,
          providerTimestamp: "2026-08-26T12:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByRole("img", { name: "Imagem" })).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:/),
    );
    expect(screen.queryByText("Mídia não suportada nesta versão")).not.toBeInTheDocument();
  });

  it.each([
    { messageType: "audio" as const, name: "Áudio" },
    { messageType: "video" as const, name: "Vídeo" },
  ])("renders $messageType without the unsupported placeholder", async ({ messageType, name }) => {
    stubConversas({
      list: [conversation],
      media: "ok",
      messages: [
        {
          id: `${messageType}-1`,
          direction: "inbound",
          messageType,
          textBody: null,
          providerTimestamp: "2026-08-26T12:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByLabelText(name)).toBeInTheDocument();
    expect(screen.queryByText("Mídia não suportada nesta versão")).not.toBeInTheDocument();
  });

  it("renders a document as a named download without the unsupported placeholder", async () => {
    stubConversas({
      list: [conversation],
      media: "ok",
      messages: [
        {
          id: "doc-1",
          direction: "inbound",
          messageType: "document",
          textBody: "orcamento.pdf",
          providerTimestamp: "2026-08-26T12:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByRole("link", { name: "orcamento.pdf" })).toHaveAttribute("download");
    expect(screen.queryByText("Mídia não suportada nesta versão")).not.toBeInTheDocument();
  });

  it("shows unavailable retry and does not execute HTML from a failed media GET", async () => {
    stubConversas({
      list: [conversation],
      media: "error-html",
      messages: [
        {
          id: "img-1",
          direction: "inbound",
          messageType: "image",
          textBody: null,
          providerTimestamp: "2026-08-26T12:00:00.000Z",
        },
      ],
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByText("Não foi possível carregar a mídia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText(/onerror/)).not.toBeInTheDocument();
    expect(screen.queryByText("Mídia não suportada nesta versão")).not.toBeInTheDocument();
  });

  it("queues one media POST on attach+confirm and clears the composer", async () => {
    const user = userEvent.setup();
    const { mediaPosts, posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enviar" })).not.toBeDisabled();
    });
    const file = new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" });
    const input = screen.getByTestId("conversas-attach-input") as HTMLInputElement;
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => {
      expect(mediaPosts()).toEqual(["media"]);
    });
    expect(posts()).toEqual([]);
    expect(screen.getByLabelText("Mensagem")).toHaveValue("");
    expect(screen.queryByText("foto.jpg")).not.toBeInTheDocument();
  });

  it("rejects an oversized attachment with no media POST", async () => {
    const user = userEvent.setup();
    const { mediaPosts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      connected: true,
    });
    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enviar" })).not.toBeDisabled();
    });
    const file = new File([new Uint8Array([1])], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: MEDIA_MAX_BYTES + 1 });
    const input = screen.getByTestId("conversas-attach-input") as HTMLInputElement;
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("O arquivo é maior que 16 MiB")).toBeInTheDocument();
    expect(mediaPosts()).toEqual([]);
  });

  it("shows [Imagem] on the list row when the API sends that snippet", async () => {
    stubConversas({
      list: [{ ...conversation, lastSnippet: "[Imagem]" }],
      messages: [],
    });
    renderConversas();
    expect(await screen.findByRole("button", { name: /\[Imagem\]/ })).toBeInTheDocument();
    expect(screen.queryByText("Mídia não suportada nesta versão")).not.toBeInTheDocument();
  });

  it("lists two vehicles with a plate and a no-plate label", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: twoVehicles,
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("ABC1D23")).toBeInTheDocument();
    expect(screen.getByText("Sem placa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar veículo" })).toBeInTheDocument();
  });

  it("adds a vehicle via conversation POST without WhatsApp", async () => {
    const user = userEvent.setup();
    const { posts, mediaPosts, vehiclePosts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: "cus-rail", vehicles: [platedVehicle] },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    // Adicionar veículo opens the creation dialog (task 7.2); the POST happens
    // when the form is saved, not on the rail control.
    await user.click(await screen.findByRole("button", { name: "Adicionar veículo" }));
    const dialog = await screen.findByRole("dialog", { name: "Adicionar veículo" });
    await user.click(within(dialog).getByRole("button", { name: "Salvar veículo" }));

    await waitFor(() => {
      expect(vehiclePosts()).toEqual(["vehicle"]);
    });
    expect(posts()).toEqual([]);
    expect(mediaPosts()).toEqual([]);
    expect(await screen.findByText("ABC1D23")).toBeInTheDocument();
    expect(screen.getByText("Sem placa")).toBeInTheDocument();
  });

  it("hides add and invents no plates when no customer is resolved", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: null, vehicles: [] },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findAllByText("Nenhum cliente vinculado")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Adicionar veículo" })).not.toBeInTheDocument();
    expect(screen.queryByText("ABC1D23")).not.toBeInTheDocument();
    expect(screen.queryByText("Sem placa")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum veículo cadastrado")).not.toBeInTheDocument();
  });

  it("shows add when the customer has zero vehicles", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: "cus-rail", vehicles: [] },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("Nenhum veículo cadastrado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar veículo" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhum cliente vinculado")).not.toBeInTheDocument();
    expect(screen.queryByText("ABC1D23")).not.toBeInTheDocument();
    expect(screen.queryByText("Sem placa")).not.toBeInTheDocument();
  });

  it("shows vehicle-list loading then Portuguese error and retry", async () => {
    const user = userEvent.setup();
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: "slow-error-then-ok",
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("Carregando veículos")).toBeInTheDocument();
    expect(await screen.findByText("Não foi possível carregar os veículos")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("ABC1D23")).toBeInTheDocument();
    expect(screen.getByText("Sem placa")).toBeInTheDocument();
  });

  it("shows a pending plate as confirmation, not a saved vehicle plate", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: null, vehicles: [] },
      prefill: { status: "pending", fields: { plate: "ABC1D23" } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    // A vehicle-shaped suggestion is one ghost row among the saved cars
    // (task 7.1), not a per-field entry in a standalone card.
    expect(await screen.findByTestId("conversas-veiculo-sugerido")).toHaveTextContent("ABC1D23");
    expect(screen.getByText("sugerido")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aceitar veículo sugerido" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recusar veículo sugerido" })).toBeInTheDocument();
    expect(screen.queryByText("Sugestão pendente de confirmação")).not.toBeInTheDocument();
    expect(screen.getAllByText("Nenhum cliente vinculado").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Sem placa")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar veículo" })).not.toBeInTheDocument();
  });

  it("shows Portuguese loading while extraction is in flight", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: "extracting",
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("Extraindo cadastro")).toBeInTheDocument();
  });

  it("empty prefill does not invent name, tax id, or vehicle values", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: null, vehicles: [] },
      prefill: { status: "empty" },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma sugestão pendente")).not.toBeInTheDocument();
    expect(screen.queryByText("Sugestão pendente de confirmação")).not.toBeInTheDocument();
    expect(screen.queryByText("sugestão")).not.toBeInTheDocument();
    expect(screen.queryByText("sugerido")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversas-veiculo-sugerido")).not.toBeInTheDocument();
    expect(screen.queryByText(/CPF\/CNPJ/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Nome:/)).not.toBeInTheDocument();
    expect(screen.queryByText("ABC1D23")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
  });

  it("shows prefill error and retries via POST", async () => {
    const user = userEvent.setup();
    const { retryPosts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "failed" },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("Não foi possível extrair o cadastro")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => {
      expect(retryPosts()).toEqual(["retry"]);
    });
    expect(await screen.findByText("Extraindo cadastro")).toBeInTheDocument();
  });

  it("disables Tentar de novo while the retry is in flight, so a double press posts once", async () => {
    // Review of #168: two quick presses both posted, and the second lost the
    // in-flight index. The button now waits for the first answer.
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "failed" },
    });
    const posts: string[] = [];
    let release!: () => void;
    const answered = new Promise<void>((done) => (release = done));
    server.use(
      http.post("*/api/conversations/:id/prefill/retry", async () => {
        posts.push("retry");
        await answered;
        return HttpResponse.json({ status: "extracting", extractEnabled: true });
      }),
    );

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByText("Não foi possível extrair o cadastro")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Tentar de novo" });

    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    fireEvent.click(button);
    release();

    // Settle the answer, then check the second press never posted.
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
    expect(posts).toEqual(["retry"]);
  });

  it("accept click posts /prefill/accept", async () => {
    const user = userEvent.setup();
    const { acceptPosts, posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: null, vehicles: [] },
      prefill: { status: "pending", fields: { plate: "ABC1D23" } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.click(await screen.findByRole("button", { name: "Aceitar veículo sugerido" }));

    await waitFor(() => {
      expect(acceptPosts()).toEqual([{ field: "plate", value: "ABC1D23" }]);
    });
    expect(posts()).toEqual([]);
  });

  it("reject click posts /prefill/reject", async () => {
    const user = userEvent.setup();
    const { rejectPosts, posts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      vehicles: { customerId: null, vehicles: [] },
      prefill: { status: "pending", fields: { plate: "ABC1D23" } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.click(await screen.findByRole("button", { name: "Recusar veículo sugerido" }));

    await waitFor(() => {
      expect(rejectPosts()).toEqual([{ field: "plate" }]);
    });
    expect(posts()).toEqual([]);
  });

  it("pending with zero keys uses empty copy", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "pending", fields: {} },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma sugestão pendente")).not.toBeInTheDocument();
    expect(screen.queryByText("Sugestão pendente de confirmação")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
  });

  it("pending without a fields object uses empty copy", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "pending" },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma sugestão pendente")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
  });

  it("shows prefill error when GET returns 500", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: "error",
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("Não foi possível extrair o cadastro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("reads the prefill again, and queues no extraction, when the READ failed", async () => {
    // Owner rulings, 2026-09-25: a failed read is not a failed extraction, so
    // "Tentar de novo" refetches instead of POSTing a retry job.
    const { retryPosts, prefillGets } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: "error",
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    expect(await screen.findByText("Não foi possível extrair o cadastro")).toBeInTheDocument();
    const readsBefore = prefillGets();

    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));

    await waitFor(() => {
      expect(prefillGets()).toBeGreaterThan(readsBefore);
    });
    expect(retryPosts()).toEqual([]);
  });

  it("accepting a year-only suggestion posts a number", async () => {
    const user = userEvent.setup();
    const { acceptPosts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "pending", fields: { year: 2020 } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.click(await screen.findByRole("button", { name: "Aceitar veículo sugerido" }));

    await waitFor(() => {
      expect(acceptPosts()).toEqual([{ field: "year", value: 2020 }]);
    });
  });

  it("accepting an odometer-only suggestion posts a number", async () => {
    const user = userEvent.setup();
    const { acceptPosts } = stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "pending", fields: { odometerKm: 40000 } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));
    await user.click(await screen.findByRole("button", { name: "Aceitar veículo sugerido" }));

    await waitFor(() => {
      expect(acceptPosts()).toEqual([{ field: "odometerKm", value: 40000 }]);
    });
  });

  it("contact rail has no suggested WhatsApp reply control", async () => {
    stubConversas({
      list: [conversation],
      messages: [inboundOi],
      prefill: { status: "pending", fields: { plate: "ABC1D23" } },
    });

    renderConversas();
    fireEvent.click(await screen.findByRole("button", { name: /11988887777/ }));

    expect(await screen.findByText("sugerido")).toBeInTheDocument();
    expect(screen.queryByText("Sugestão pendente de confirmação")).not.toBeInTheDocument();
    expect(screen.queryByText(/resposta sugerida/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/copiloto/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enviar sugestão/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/resposta da IA/i)).not.toBeInTheDocument();
  });
});
