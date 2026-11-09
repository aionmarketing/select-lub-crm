/**
 * Page object for the Follow-up screen at `/follow-up`.
 *
 * Four counted cards sit above three section lists; selecting a card filters to
 * its section. Each section is a named `region` whose heading carries the
 * ordering it promises, and each entry offers `Abrir conversa`, `Criar lembrete`
 * and an archive control. The archive buttons are deliberately located by their
 * full sentence-long accessible names — that copy is itself specified (the
 * vencido head mark names the reopen rule), so a shorter locator would drift
 * away from the thing the spec pins.
 *
 * Oracle: openspec/specs/conversations/follow-up/spec.md (Follow-up screen with four sections;
 * Section counts are a shared contract; Entries can be closed).
 */
import type { Page } from "@playwright/test";

/** The four Follow-up sections, by the heading text each renders. */
export const FOLLOW_UP_SECTIONS = [
  "Mensagens aguardando resposta",
  "Orçamentos sem resposta",
  "Retorno vencido",
  "Retorno se aproximando",
] as const;

/** Name of one Follow-up section. */
export type FollowUpSection = (typeof FOLLOW_UP_SECTIONS)[number];

/** Locators for the `/follow-up` counts, sections, and per-entry actions. */
export class FollowUpPage {
  /**
   * Binds locators to the Playwright page under test.
   * @param page - Browser tab hosting the CRM SPA.
   */
  constructor(private readonly page: Page) {}

  /**
   * Navigates to the Follow-up route.
   * @returns Playwright navigation promise for `/follow-up`.
   */
  goto() {
    return this.page.goto("/follow-up");
  }

  /**
   * Locator for the screen's level-1 heading.
   * @returns Playwright locator for the `Follow-up` heading.
   */
  heading() {
    return this.page.getByRole("heading", { level: 1, name: "Follow-up" });
  }

  /**
   * Locator for one section's count card.
   *
   * The card's accessible name is its section name followed by the count, so
   * matching on the name alone finds the card whatever the number is — the
   * count itself is read with {@link countValue}.
   * @param section - Section whose card to locate.
   * @returns Playwright locator for that count card button.
   */
  countCard(section: FollowUpSection) {
    return this.page.getByRole("button", { name: new RegExp(`^${section} `) });
  }

  /**
   * Reads the number printed on a section's count card.
   * @param section - Section whose count to read.
   * @returns The count as displayed, or `null` when the card states no number.
   */
  async countValue(section: FollowUpSection) {
    const name = await this.countCard(section).getAttribute("aria-label");
    const text = name ?? (await this.countCard(section).innerText());
    const match = /(\d+)\s*$/.exec(text.trim());
    return match ? Number(match[1]) : null;
  }

  /**
   * Locator for one section's list region.
   * @param section - Section whose region to locate.
   * @returns Playwright locator for the named region.
   */
  section(section: FollowUpSection) {
    return this.page.getByRole("region", { name: section });
  }

  /**
   * Locator for the ordering subtitle a section's heading promises.
   * @param section - Section whose subtitle to locate.
   * @returns Playwright locator for the subtitle paragraph.
   */
  sectionOrdering(section: FollowUpSection) {
    return this.section(section).getByText(/primeiro/);
  }

  /**
   * Locator for a section's explicit empty state.
   * @param section - Section to check.
   * @returns Playwright locator for the `Nenhum…` paragraph inside it.
   */
  emptyState(section: FollowUpSection) {
    return this.section(section).getByText(/^Nenhum/);
  }

  /**
   * Locator for every `Abrir conversa` link inside a section.
   * @param section - Section whose entries to inspect.
   * @returns Playwright locator matching those links.
   */
  abrirConversaLinks(section: FollowUpSection) {
    return this.section(section).getByRole("link", { name: "Abrir conversa" });
  }

  /**
   * Counts the entries a section lists, whatever the entry's shape.
   *
   * The two shapes that matter differ in what every entry is guaranteed to
   * carry. A Retorno vencido entry is a customer, and the spec lets a customer
   * have no conversation ("A return without a conversation has no Abrir
   * conversa"), so counting that link under-counts whenever such a customer is
   * queued — which the seed's Omie mock customer is. Its head mark is on every
   * entry that is still in the queue. The other listed sections' entries all
   * carry a conversation, so their link is the entry's own handle.
   *
   * This is the number the spec's "Count matches list" compares with the card.
   * @param section - A section that renders a list by default.
   * @returns How many entries the section lists right now.
   */
  entryCount(section: FollowUpSection) {
    return section === "Retorno vencido"
      ? this.arquivarClienteButtons(section).count()
      : this.abrirConversaLinks(section).count();
  }

  /**
   * Locator for one customer's entry inside Retorno vencido.
   *
   * Located by what the entry holds — the customer's link and a per-vehicle
   * archive control — and taking the deepest match, because every ancestor up
   * to the section holds both too. Needed because the queue is ordered most
   * overdue first and carries customers the tour does not own: `.first()` on a
   * section-wide locator archives whoever is on top, not the customer under
   * tour.
   * @param customerName - The label the entry's head prints.
   * @returns Playwright locator for that customer's entry.
   */
  overdueEntryOf(customerName: string) {
    return this.section("Retorno vencido")
      .locator("div")
      .filter({ has: this.page.getByRole("link", { name: customerName }) })
      .filter({ has: this.page.getByRole("button", { name: "Arquivar este retorno" }) })
      .last();
  }

  /**
   * Locator for every `Criar lembrete` control inside a section.
   * @param section - Section whose entries to inspect.
   * @returns Playwright locator matching those buttons.
   */
  criarLembreteButtons(section: FollowUpSection) {
    return this.section(section).getByRole("button", { name: "Criar lembrete" });
  }

  /**
   * Locator for the per-return archive control inside a section.
   * @param section - Section whose entries to inspect.
   * @returns Playwright locator matching those buttons.
   */
  arquivarRetornoButtons(section: FollowUpSection) {
    return this.section(section).getByRole("button", { name: "Arquivar este retorno" });
  }

  /**
   * Locator for the customer-level archive control, whose name states the
   * reopen rule the spec requires it to state.
   * @param section - Section whose entries to inspect.
   * @returns Playwright locator matching those buttons.
   */
  arquivarClienteButtons(section: FollowUpSection) {
    return this.section(section).getByRole("button", {
      name: /^Arquivar os retornos abertos deste cliente/,
    });
  }

  /**
   * Locator for a section's archived strip.
   * @param section - Section whose archived strip to locate.
   * @returns Playwright locator for the `Ver o arquivado` control.
   */
  verArquivado(section: FollowUpSection) {
    return this.section(section).getByRole("button", { name: /^Ver o arquivado/ });
  }

  // --- Criar lembrete form (added for task 5.5's tour) ---

  /**
   * Locator for the reminder form, which opens over Follow-up without leaving it.
   * @returns Role locator for the `Criar lembrete` dialog.
   */
  reminderDialog() {
    return this.page.getByRole("dialog", { name: "Criar lembrete" });
  }

  /**
   * Locator for the reminder body field.
   *
   * Left blank on purpose by the tour: the spec says a blank body takes the
   * composed default rather than refusing the form.
   * @returns Locator for the message textarea.
   */
  reminderBody() {
    return this.reminderDialog().getByRole("textbox").first();
  }

  /**
   * Locator for the first notice-moment date field in the reminder form.
   * @returns Locator for the `Dia` field.
   */
  reminderNoticeDate() {
    return this.reminderDialog().locator('input[type="date"]').first();
  }

  /**
   * Locator for the reminder form's commit control.
   * @returns Role locator for `Confirmar`.
   */
  reminderConfirm() {
    return this.reminderDialog().getByRole("button", { name: "Confirmar" });
  }

  /**
   * Locator for the reminder form's abandon control.
   * @returns Role locator for `Cancelar`.
   */
  reminderCancel() {
    return this.reminderDialog().getByRole("button", { name: "Cancelar" });
  }

  /**
   * Locator for the "N lembrete(s) · próximo …" summary on a return row.
   *
   * Matched by shape rather than by a count or a date: both come from the
   * fixture and the clock, while the summary's presence is the behaviour.
   * @returns Locator for the planned-reminder summary.
   */
  plannedSummary() {
    return this.page.getByText(/\d+ lembrete/);
  }
}
