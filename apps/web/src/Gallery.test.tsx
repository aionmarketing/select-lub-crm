/**
 * Test design (testing-strategy)
 *
 * Setup: render <Gallery /> inside AppProviders. No MSW. user-event types
 * into the Nome field.
 *
 * Spec rule (openspec/specs/design-system/spec.md living gallery):
 *   Required widgets plus Portuguese copy. Amber-as-text on white is not
 *   offered. Nome is a labeled text field.
 *
 * Partitions (one numbered group = gallery states the spec treats the same):
 *
 *   P1 VALID   — title heading: getByRole("heading", { name: appTitle })
 *   P2 VALID   — Nome empty (default) still labeled "Nome"
 *   P3 VALID   — Nome filled: typing a short name updates the value
 *   P4 VALID   — primary / secondary / WhatsApp buttons, card, error field
 *   P5 INVALID — body copy must not use color="primary" (amber-as-text)
 *
 * Output partitions:
 *   O1 — heading with appTitle is in the document (P1)
 *   O2 — labeled Nome field; value matches what was typed (P2/P3)
 *   O3 — required gallery widgets present (P4)
 *   O4 — intro Typography is not MuiTypography-colorPrimary (P5)
 *
 * Limits (boundary value analysis):
 *   Empty string (default) vs one typed character then a short name.
 *
 * Map from each `it` to a partition:
 *
 *   exposes the product title as a heading — P1
 *   accepts text in the Nome field — P2/P3
 *   shows primary, secondary, WhatsApp, card, and error field — P4
 *   does not present primary-on-surface as body text — P5
 *
 * What would make a test fail:
 *   title in a <div> with no heading role
 *   missing Orçamento / WhatsApp buttons
 *   intro copy using MuiTypography-colorPrimary
 *
 * Out of scope: palette hexes (theme.test.ts); visual-QA screenshots.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppProviders } from "./AppProviders.js";
import { appTitle } from "./appTitle.js";
import { Gallery } from "./Gallery.js";

describe("Gallery", () => {
  it("exposes the product title as a heading", () => {
    render(
      <AppProviders>
        <Gallery />
      </AppProviders>,
    );

    expect(screen.getByRole("heading", { name: appTitle })).toBeInTheDocument();
  });

  it("accepts text in the Nome field", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders>
        <Gallery />
      </AppProviders>,
    );

    const nome = screen.getByLabelText("Nome");

    await user.type(nome, "Ana");

    expect(nome).toHaveValue("Ana");
  });

  it("shows primary, secondary, WhatsApp, card, and error field", () => {
    render(
      <AppProviders>
        <Gallery />
      </AppProviders>,
    );

    expect(screen.getByRole("button", { name: "Ação principal" })).toHaveClass(
      "MuiButton-colorPrimary",
    );
    expect(screen.getByRole("button", { name: "Orçamento" })).toHaveClass(
      "MuiButton-colorSecondary",
    );
    expect(screen.getByRole("button", { name: "Enviar no WhatsApp" })).toHaveClass(
      "MuiButton-colorWhatsapp",
    );
    expect(screen.getByRole("heading", { name: "Cartão de exemplo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Placa")).toBeInTheDocument();
    expect(screen.getByText("Placa inválida")).toBeInTheDocument();
  });

  it("does not present primary-on-surface as body text", () => {
    render(
      <AppProviders>
        <Gallery />
      </AppProviders>,
    );

    expect(screen.getByText(/Galeria de tokens/)).not.toHaveClass("MuiTypography-colorPrimary");
  });
});
