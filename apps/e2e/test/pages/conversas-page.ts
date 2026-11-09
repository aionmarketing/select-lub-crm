/**
 * Page object for the Conversas attendant inbox in Playwright e2e tests.
 */
import type { Page } from "@playwright/test";

/** Locators and navigation helpers for the `/` Conversas screen. */
export class ConversasPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Conversas route.
   * @returns Playwright navigation promise for `GET /` (client-side route).
   */
  goto() {
    return this.page.goto("/");
  }

  /**
   * Opens a conversation by id via the inbox query string (same as Follow-up links).
   * @param id - CRM conversation id
   * @returns Playwright navigation promise for `GET /?conversation=`
   */
  gotoConversation(id: string) {
    return this.page.goto(`/?conversation=${id}`);
  }

  /**
   * Locator for the inbox panel listing conversations.
   * @returns Playwright locator for `data-testid="conversas-inbox"`.
   */
  inbox() {
    return this.page.getByTestId("conversas-inbox");
  }

  /**
   * Locator for the list row matching the given phone or name display text.
   * @param label - Contact phone or name substring shown in the inbox row.
   * @returns Filtered locator for `data-testid="conversas-list-item"`.
   */
  listItem(label: string) {
    return this.page.getByTestId("conversas-list-item").filter({ hasText: label });
  }

  /**
   * Locator for the inbox row of a seeded conversation id.
   * @param id - Conversation id from SQL fixtures.
   * @returns Locator matching `data-conversation-id`.
   */
  listConversation(id: string) {
    return this.page.locator(`[data-testid="conversas-list-item"][data-conversation-id="${id}"]`);
  }

  /**
   * Locator for the message compose field.
   * @returns Playwright locator for `data-testid="conversas-composer"`.
   */
  composer() {
    return this.page.getByTestId("conversas-composer");
  }

  /**
   * Locator for the send button in the compose rail.
   * @returns Playwright locator for `data-testid="conversas-send-button"`.
   */
  sendButton() {
    return this.page.getByTestId("conversas-send-button");
  }

  /**
   * Locator for Programar mensagem on a service with no non-cancelled schedule.
   * @param serviceId - Seeded service id used in `data-service-id`.
   * @returns Playwright locator for that service's `conversas-programar-free` button.
   */
  programarFree(serviceId: string) {
    return this.page.locator(
      `[data-testid="conversas-programar-free"][data-service-id="${serviceId}"]`,
    );
  }

  /**
   * Locator for Programar mensagem on a service that already has a schedule.
   * @param serviceId - Seeded service id used in `data-service-id`.
   * @returns Playwright locator for that service's `conversas-programar-occupied` button.
   */
  programarOccupied(serviceId: string) {
    return this.page.locator(
      `[data-testid="conversas-programar-occupied"][data-service-id="${serviceId}"]`,
    );
  }

  /**
   * Locator for the schedule dialog confirm control.
   * @returns Playwright locator for `data-testid="conversas-schedule-confirm"`.
   */
  scheduleConfirm() {
    return this.page.getByTestId("conversas-schedule-confirm");
  }

  /**
   * Locator for the schedule dialog date field (day, America/Sao_Paulo).
   * @returns Playwright locator for the labeled `Data` input inside the dialog.
   */
  scheduleDate() {
    return this.page.getByRole("dialog", { name: "Programar mensagem" }).getByLabel("Data");
  }

  /**
   * Locator for the schedule dialog time field (clock, America/Sao_Paulo).
   * @returns Playwright locator for the labeled `Hora` input inside the dialog.
   */
  scheduleTime() {
    return this.page.getByRole("dialog", { name: "Programar mensagem" }).getByLabel("Hora");
  }

  /**
   * Locator for the schedule dialog message field.
   * @returns Playwright locator for `data-testid="conversas-schedule-text"`.
   */
  scheduleText() {
    return this.page.getByTestId("conversas-schedule-text");
  }

  /**
   * Locator for the cadastro rail save control.
   * @returns Playwright locator for `data-testid="conversas-cadastro-save"`.
   */
  cadastroSave() {
    return this.page.getByTestId("conversas-cadastro-save");
  }

  /**
   * Locator for the cadastro rail Editar control.
   * @returns Playwright locator for `data-testid="conversas-cadastro-edit"`.
   */
  cadastroEdit() {
    return this.page.getByTestId("conversas-cadastro-edit");
  }

  /**
   * Locator for the cadastro Nome field while editing.
   * @returns Playwright locator for `data-testid="conversas-cadastro-name"`.
   */
  cadastroName() {
    return this.page.getByTestId("conversas-cadastro-name");
  }

  /**
   * Locator for a Mensagens programadas preview row whose title contains `text`.
   * @param text - Frozen body (or unique prefix) shown as the row title
   * @returns Locator for `conversas-programada-row` filtered by that text
   */
  programadaRow(text: string) {
    return this.page.getByTestId("conversas-programada-row").filter({ hasText: text });
  }

  /**
   * Locator for Cancelar envio on the scheduled-message drill-in.
   * @returns Role locator for the cancel control
   */
  scheduleCancelSend() {
    return this.page.getByRole("button", { name: "Cancelar envio" });
  }

  // --- Inbox toolbar, tags, and Nova conversa (added for the tour of task 5.3) ---

  /**
   * Locator for the inbox search field.
   *
   * Located by its accessible name rather than by "the text input in `main`":
   * once a thread is open the composer is a second text input, and a
   * shape-based locator resolves to both.
   * @returns Role locator for the `Buscar` textbox.
   */
  searchField() {
    return this.page.getByRole("textbox", { name: "Buscar" });
  }

  /**
   * Locator for every conversation row currently listed.
   * @returns Locator matching all `conversas-list-item` rows.
   */
  listItems() {
    return this.page.getByTestId("conversas-list-item");
  }

  /**
   * Locator for the explicit "no thread matched" line.
   * @param term - Search term the screen is expected to name back.
   * @returns Locator for the empty-search message.
   */
  emptySearchMessage(term: string) {
    return this.page.getByText(`Nenhuma conversa para "${term}"`);
  }

  /**
   * Locator for the contact rail's control that applies a tag.
   * @param tagName - Tag name as catalogued.
   * @returns Role locator for the `Aplicar <tag>` button.
   */
  applyTagButton(tagName: string) {
    return this.page.getByRole("button", { name: `Aplicar ${tagName}` });
  }

  /**
   * Locator for the inbox toolbar's tag filter chip.
   *
   * Scoped by the outlined chip variant because the same tag name also appears
   * as an applied chip in the contact rail; the filter is the clickable
   * outlined one in the toolbar.
   * @param tagName - Tag name as catalogued.
   * @returns Locator for that filter chip.
   */
  tagFilterChip(tagName: string) {
    return this.page.locator(".MuiChip-outlined").filter({ hasText: tagName });
  }

  /**
   * Locator for the chip that clears the tag filter.
   * @returns Locator for the `Todas` chip.
   */
  tagFilterAll() {
    return this.page.locator(".MuiChip-root").filter({ hasText: "Todas" }).first();
  }

  /**
   * Locator for the button that opens the Nova conversa dialog.
   * @returns Role locator for `Nova conversa`.
   */
  novaConversaButton() {
    return this.page.getByRole("button", { name: "Nova conversa" });
  }

  /**
   * Locator for the Nova conversa dialog.
   * @returns Role locator for the named dialog.
   */
  novaConversaDialog() {
    return this.page.getByRole("dialog", { name: "Nova conversa" });
  }

  /**
   * Locator for the phone field inside the Nova conversa dialog.
   * @returns Locator for the dialog's only text input.
   */
  novaConversaPhone() {
    return this.novaConversaDialog().getByRole("textbox");
  }

  /**
   * Locator for the Nova conversa commit control.
   * @returns Role locator for `Iniciar`.
   */
  novaConversaStart() {
    return this.novaConversaDialog().getByRole("button", { name: "Iniciar" });
  }

  /**
   * Locator for the Nova conversa abandon control.
   * @returns Role locator for `Cancelar`.
   */
  novaConversaCancel() {
    return this.novaConversaDialog().getByRole("button", { name: "Cancelar" });
  }

  // --- Contact rail: vehicles and the prefill switch (added for task 5.4's tour) ---

  /**
   * Locator for a vehicle row on the contact rail, by plate.
   *
   * Matched on visible text. That began as a workaround: the row used to carry
   * `aria-label="Ver <make> <model> <year>"`, which replaced the plate for
   * name-based lookups even though the plate is what the row visibly leads
   * with — the tour finding recorded as D3. The `aria-label` is gone, so
   * `getByRole("button", { name: plate })` would now work for the cursor
   * variant; text matching is kept because it also matches antigravity, whose
   * visible title is `<make> <model> <year> · <plate>`, and because matching
   * what a person can see is the more durable rule for a tour.
   * @param plate - Plate as displayed.
   * @returns Locator for the drill-in trigger carrying that plate.
   */
  vehicleRow(plate: string) {
    return this.page.getByRole("button").filter({ hasText: plate });
  }

  /**
   * Locator for the control that opens the add-vehicle form.
   * @returns Role locator for `Adicionar veículo` in the rail.
   */
  addVehicleButton() {
    return this.page.getByRole("button", { name: "Adicionar veículo", exact: true });
  }

  /**
   * Locator for the add-vehicle dialog.
   *
   * Resolved from the page rather than from `main`: MUI renders dialogs through
   * a portal at the document root, so a `main`-scoped locator misses it.
   * @returns Role locator for the dialog.
   */
  vehicleDialog() {
    return this.page.getByRole("dialog");
  }

  /**
   * Locator for the plate field inside the add-vehicle dialog.
   * @returns Locator for the dialog's plate input.
   */
  vehiclePlateField() {
    return this.vehicleDialog().getByRole("textbox").first();
  }

  /**
   * Locator for one identity field inside the add-vehicle dialog.
   * @param label - Visible field label (`Marca`, `Modelo`, `Ano`, …).
   * @returns Locator for that field.
   */
  vehicleField(label: string) {
    return this.vehicleDialog().getByLabel(label, { exact: true });
  }

  /**
   * Locator for the add-vehicle commit control.
   * @returns Role locator for `Salvar veículo`.
   */
  saveVehicleButton() {
    return this.vehicleDialog().getByRole("button", { name: "Salvar veículo" });
  }

  /**
   * Locator for the message shown when a plate resolves to nothing.
   * @returns Locator for the not-found line.
   */
  plateNotFound() {
    return this.page.getByText("A consulta não devolveu dados para esta placa.");
  }

  /**
   * Locator for the per-conversation cadastro-extraction switch.
   *
   * The visible control is a label wrapping a checkbox; the checkbox is what
   * carries the on/off state a tour reads.
   * @returns Locator for the switch's checkbox input.
   */
  prefillSwitch() {
    return this.prefillSwitchLabel().locator('input[type="checkbox"]');
  }

  /**
   * Locator for the clickable label of the cadastro-extraction switch.
   *
   * Toggling goes through the label rather than the hidden input: the input is
   * a controlled MUI switch, and driving it directly can flip the native
   * checkbox without React's handler running, which looks like a successful
   * toggle in the DOM while nothing is persisted.
   * @returns Locator for the switch's label.
   */
  prefillSwitchLabel() {
    return this.page.locator("label").filter({ hasText: "Sugerir dados do cliente" });
  }

  // --- Rail drill-ins: vehicles and services (added for task 5.5's tour) ---

  /**
   * Locator for the control that returns from a drill-in to the profile stack.
   * @returns Role locator for the rail's back control.
   */
  railBack() {
    return this.page.getByRole("button", { name: /Voltar/ });
  }

  /**
   * Locator for a service row in the rail preview or a vehicle's history.
   * @param description - Service description, or a unique part of it.
   * @returns Locator for that service row.
   */
  serviceRow(description: string) {
    return this.page.getByRole("button").filter({ hasText: description });
  }

  /**
   * Locator for a vehicle drill-in's empty service history.
   * @returns Locator for the per-vehicle empty state.
   */
  vehicleHistoryEmpty() {
    return this.page.getByText("Nenhum serviço registrado para este veículo");
  }

  /**
   * Locator for the drill-in heading naming the vehicle currently open.
   * @param plate - Plate expected in the heading.
   * @returns Locator for the drill-in title.
   */
  drillInTitle(plate: string) {
    return this.page.getByText(new RegExp(`· ${plate}$`, "m"));
  }

  // --- Oil quote (added for task 5.6's tour) ---

  /**
   * Locator for a vehicle's Montar orçamento trigger.
   *
   * Scoped to the vehicle's own row so a customer with several cars cannot
   * silently open the wrong one — which is the failure this tour looks for.
   * @param plate - Plate of the vehicle whose quote to open.
   * @returns Locator for that row's quote trigger.
   */
  montarOrcamento(plate: string) {
    // Scoped to the *innermost* element holding both this plate's row control
    // and a quote trigger. `filter({ hasText })` alone is not enough: every
    // ancestor up to the rail also contains the plate, and the whole Veículos
    // block contains every vehicle's trigger — so a naive filter happily
    // returns a sibling's button. Matches come back in document order, so the
    // last container that satisfies both conditions is the row itself.
    const row = this.page
      .locator("div")
      .filter({ has: this.page.getByRole("button").filter({ hasText: plate }) })
      .filter({ has: this.page.getByRole("button", { name: "Montar orçamento" }) })
      .last();
    return row.getByRole("button", { name: "Montar orçamento" });
  }

  /**
   * Locator for the oil-quote dialog.
   * @returns Role locator for the dialog whose name starts with the quote title.
   */
  quoteDialog() {
    return this.page.getByRole("dialog", { name: /Montar orçamento/ });
  }

  /**
   * Locator for the quote dialog's close control.
   * @returns Role locator for `Fechar`.
   */
  quoteClose() {
    return this.quoteDialog().getByRole("button", { name: "Fechar" });
  }

  // --- Oil-quote reuse path (added for close-stated-coverage-gaps section 6) ---

  /**
   * Locator for the `Montar orçamento` trigger on ONE vehicle's rail row.
   *
   * Narrowed to the container that carries both the vehicle's label and a
   * trigger: every row has a trigger, and the label alone matches an element
   * with no button in it.
   * @param vehicleLabel - The row's visible label — a plate, or make/model/year
   * for a vehicle with no plate.
   * @returns Locator for that row's trigger.
   */
  quoteTriggerFor(vehicleLabel: string) {
    return this.page
      .locator("div")
      .filter({ hasText: vehicleLabel })
      .filter({ has: this.page.getByRole("button", { name: "Montar orçamento" }) })
      .last()
      .getByRole("button", { name: "Montar orçamento" });
  }

  /**
   * Locator for `Buscar novamente`.
   *
   * Since background-oil-research it is a POST that only queues a research, so
   * clicking it reaches no provider. **Still do not click it in a tour:** a
   * worker pointed at the same database would run that research for real. It
   * exists so a tour can assert the action is offered.
   * @returns Locator for the refetch control.
   */
  quoteRefetch() {
    return this.quoteDialog().getByRole("button", { name: "Buscar novamente" });
  }

  /**
   * Locator for the quote dialog's one status region (D17): loading, the
   * research sentence, the row's date or the outcome, as its text changes.
   * @returns Role locator for the dialog's `role="status"` element.
   */
  quoteStatus() {
    return this.quoteDialog().getByRole("status");
  }

  /**
   * Locator for the research counter, a `role="timer"` outside the status.
   * @returns Role locator for the counter.
   */
  quoteTimer() {
    return this.quoteDialog().getByRole("timer");
  }

  /**
   * Locator for one oil card's select control inside the quote.
   * @param name - The card's brand and product, e.g. `Motul 8100 Eco-nergy`.
   * @returns Locator for that card's control.
   */
  quoteCard(name: string) {
    return this.quoteDialog().getByRole("button", { name: new RegExp(name) });
  }

  /**
   * Locator for one oil card's editable price (close-stated-coverage-gaps 3.2).
   *
   * Scoped to the card's own outlined container — the parent of its select
   * control — because every card's field is named `Preço`, so a dialog-wide
   * role query cannot tell them apart without relying on order.
   *
   * @param name - The card's brand and product, e.g. `Motul 8100 Eco-nergy`.
   * @returns Locator for that card's `Preço` textbox.
   */
  quoteCardPrice(name: string) {
    return this.quoteCard(name).locator("xpath=..").getByRole("textbox", { name: "Preço" });
  }

  /**
   * Locator for one candidate in a filter chooser (close-stated-coverage-gaps 3.2).
   * @param type - The chooser's label, `Filtro de óleo` or `Filtro de combustível`.
   * @param partNumber - The candidate's part number, e.g. `PSL545`.
   * @returns Locator for that candidate's toggle button.
   */
  quoteFilterChoice(type: string, partNumber: string) {
    return this.quoteDialog()
      .getByRole("group", { name: type })
      .getByRole("button", { name: new RegExp(`· ${partNumber.replace(/[/.]/g, "\\$&")} ·`) });
  }

  /**
   * Locator for the assembled customer message inside the quote.
   * @returns Locator for the message textbox.
   */
  quoteMessage() {
    return this.quoteDialog().getByRole("textbox", { name: "Mensagem" });
  }

  // --- The three dead ends' ways out (background-oil-research task 5.12, D24) ---

  /**
   * Locator for the missing volume's input, named by its visible label.
   * @returns Role locator for the volume textbox.
   */
  quoteVolumeInput() {
    return this.quoteDialog().getByRole("textbox", { name: "Volume de óleo da troca (litros)" });
  }

  /**
   * Locator for "Usar este volume".
   * @returns Role locator for the button that uses the typed volume.
   */
  quoteUseVolume() {
    return this.quoteDialog().getByRole("button", { name: "Usar este volume" });
  }

  /**
   * Locator for "Usar mesmo assim", the high-volume warning's confirmation.
   * @returns Role locator for the confirmation button.
   */
  quoteUseHighVolume() {
    return this.quoteDialog().getByRole("button", { name: "Usar mesmo assim" });
  }

  /**
   * Locator for the "Guardar … como volume da troca …?" prompt, a dialog over the quote.
   * @returns Role locator for the prompt dialog.
   */
  saveFillPrompt() {
    return this.page.getByRole("dialog", { name: /^Guardar .* como volume da troca/ });
  }

  /**
   * Locator for one engine button of a clarification, labelled with the engine verbatim.
   * @param engine - The engine as the source named it, e.g. `1.8 Dual VVT-i`.
   * @returns Role locator for that engine's button.
   */
  quoteEngine(engine: string) {
    return this.quoteDialog().getByRole("button", { name: engine, exact: true });
  }

  /**
   * Locator for "Nenhum destes? Corrigir versão do veículo", below the engine buttons.
   * @returns Role locator for the fallback button.
   */
  quoteNoneOfTheseEngines() {
    return this.quoteDialog().getByRole("button", { name: "Nenhum destes? Corrigir versão do veículo" });
  }

  /**
   * Locator for one disputed grade's choice in a conflict (a `role="radio"` option).
   * @param grade - The SAE grade the option starts with, e.g. `5W-30`.
   * @returns Role locator for that grade's radio.
   */
  quoteGradeChoice(grade: string) {
    return this.quoteDialog().getByRole("radio", { name: new RegExp(`^${grade.replace(/[-.]/g, "\\$&")} — `) });
  }

  /**
   * Locator for one source's volume in a volume conflict (a `role="radio"` option).
   * @param liters - The volume as the option writes it, e.g. `4,3 L`.
   * @returns Role locator for that volume's radio.
   */
  quoteVolumeChoice(liters: string) {
    return this.quoteDialog().getByRole("radio", { name: new RegExp(`^${liters.replace(/[.,]/g, "\\$&")} — `) });
  }

  /**
   * Locator for "Enviar via WhatsApp". **Do not click it in a tour:** it saves a quote.
   * @returns Role locator for the send button.
   */
  quoteSend() {
    return this.quoteDialog().getByRole("button", { name: "Enviar via WhatsApp" });
  }

  // --- Assistive-prefill ghosts (added for close-stated-coverage-gaps task 3.1) ---

  /**
   * Locator for the control that accepts one suggested cadastro field.
   *
   * Located by accessible name, not by test id: the ghost has no test id of its
   * own, and both UI variants build the label the same way — `Aceitar ${label}`
   * in `prefill.suggestions.cursor.tsx` and `.antigravity.tsx` alike — so one
   * locator covers whichever variant is serving.
   * @param fieldLabel - The field's visible label, e.g. `Nome`.
   * @returns Role locator for that field's accept control.
   */
  prefillGhostAccept(fieldLabel: string) {
    return this.page.getByRole("button", { name: `Aceitar ${fieldLabel}` });
  }

  /**
   * Locator for the control that refuses one suggested cadastro field.
   * @param fieldLabel - The field's visible label, e.g. `Nome`.
   * @returns Role locator for that field's refuse control.
   */
  prefillGhostReject(fieldLabel: string) {
    return this.page.getByRole("button", { name: `Recusar ${fieldLabel}` });
  }

  // --- Omie reconciliation pendings (added for close-stated-coverage-gaps 3.4) ---

  /**
   * Locator for the inbox header control that opens the pendings panel.
   *
   * Matched on the label's PREFIX, because the control appends the open count
   * (`Pendências com o Omie, 4`) and a tour must not be pinned to a number that
   * the demo fixtures also move.
   * @returns Locator for the pendings control.
   */
  omiePendingsButton() {
    return this.page.locator('button[aria-label^="Pendências com o Omie"]');
  }

  /**
   * Locator for the all-customers pendings dialog.
   * @returns Role locator for the dialog.
   */
  omiePendingsDialog() {
    return this.page.getByRole("dialog", { name: /Pendências com o Omie/ });
  }

  /**
   * Locator for the dialog's headline, which counts FIELDS still unresolved.
   * @returns Locator for the headline alert.
   */
  omiePendingsHeadline() {
    return this.omiePendingsDialog().getByText(/campos? ainda sem resolução/);
  }

  /**
   * Locator for one customer's group inside the pendings dialog.
   * @param customerName - The customer's display name, as the group heading.
   * @returns Locator for the innermost container holding that group.
   */
  omiePendingGroup(customerName: string) {
    return this.omiePendingsDialog()
      .locator("div")
      .filter({ has: this.page.getByRole("heading", { name: customerName }) })
      .last();
  }

  /**
   * Locator for ONE field's block within the pendings dialog.
   *
   * Identified by a value only that row carries, and narrowed to the container
   * that also holds the choice controls. Filtering on the value alone would
   * match the diff row, which has no buttons; filtering on the buttons alone
   * would match every field.
   * @param uniqueValue - A CRM or Omie value unique to that row.
   * @returns Locator for that field's block, controls included.
   */
  omiePendingField(uniqueValue: string) {
    return this.omiePendingsDialog()
      .locator("div")
      .filter({ hasText: uniqueValue })
      .filter({ has: this.page.getByRole("button", { name: "Usar Omie" }) })
      .last();
  }
}
