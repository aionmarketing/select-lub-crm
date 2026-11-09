/**
 * Test design (testing-strategy)
 *
 * Setup: LabeledInput / LabeledSelect rendered bare (MUI's default theme is
 * enough; nothing here reads the palette). user-event for typing and picking.
 *
 * Oracle: design-system delta "Screen pages share the canvas foundation"
 * (align-shipped-ui-to-pdf-artboards) — "A field's label is above its input
 * … and the control's accessible name is that label"; the Relatórios and
 * Usuários tests reach every control by `getByLabelText`, so the name has to
 * survive the move away from MUI's floating label.
 *
 * Axes
 *   A1 control kind — input (native label[for]) / select (aria-labelledby)
 *   A2 interaction — value typed / option picked
 *   A3 helper — omitted / error helperText
 *
 * Outputs
 *   O1 getByLabelText(label) resolves the control (input / combobox)
 *   O2 the label element precedes the control in DOM order
 *   O3 onChange sees the typed value / the picked option
 *   O4 error helper is aria-describedby and aria-invalid
 *
 * Sampled-cell
 *   input named by its label    | A1 input  | O1 O2 O3 | label floats, or name lost
 *   select named by its label   | A1 select | O1 O2 O3 | combobox not found by label
 *
 * Decision map: neither component branches; `FieldLabel`'s two optional ids are
 * exercised one per it (htmlFor by the input it, id by the select it).
 *
 * Out of scope: the set-filter look (RelatoriosPage tests); disabled selects
 * (`aria-disabled` is MUI's own behaviour, asserted where it matters).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LabeledInput, LabeledSelect, MenuItem } from "./LabeledField.js";

function DateField({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("2026-08-01");
  return (
    <LabeledInput
      id="inicio"
      label="Início"
      type="date"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}

describe("LabeledInput", () => {
  it("names the input by the label drawn above it and passes typed values on", async () => {
    const onChange = vi.fn();
    render(<DateField onChange={onChange} />);

    const input = screen.getByLabelText("Início");
    const label = screen.getByText("Início");
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, "2026-08-28");

    expect(input).toHaveAttribute("id", "inicio");
    expect(input).toHaveAttribute("type", "date");
    expect(
      label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith("2026-08-28");
  });

  it("names an inline error from the input via aria-describedby", () => {
    render(
      <LabeledInput
        id="placa"
        label="Placa"
        error
        helperText="Placa inválida"
        defaultValue=""
      />,
    );

    const input = screen.getByLabelText("Placa");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "placa-helper");
    expect(document.getElementById("placa-helper")).toHaveTextContent("Placa inválida");
  });
});

describe("LabeledSelect", () => {
  it("names the combobox by the label drawn above it and reports the picked option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LabeledSelect<string>
        id="granularidade"
        label="Granularidade"
        value="day"
        onChange={(event) => onChange(event.target.value)}
      >
        <MenuItem value="day">Dia</MenuItem>
        <MenuItem value="week">Semana</MenuItem>
      </LabeledSelect>,
    );

    const combobox = screen.getByLabelText("Granularidade");
    const label = screen.getByText("Granularidade");
    await user.click(combobox);
    await user.click(await screen.findByRole("option", { name: "Semana" }));

    expect(combobox).toHaveAttribute("role", "combobox");
    expect(
      label.compareDocumentPosition(combobox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith("week");
  });
});
