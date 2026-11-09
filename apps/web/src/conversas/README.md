# conversas

Conversas screen regions composed by `ConversasPage` in `../ConversasPage.tsx`.

- **helpers.ts** — origin/channel labels, debounce, media type, São Paulo dates, contact/prefill/schedule formatters
- **inbox.tsx** — `ChannelChip`, `NovaConversaControl`, `TagFilter`, `ConversationList`
- **thread.tsx** — `ThreadPane` (messages, ticks, media, composer)
- **contact-rail.tsx** — `ContactRail` composer (cadastro + tags + extraction switch) and re-exports `OmiePendenciasPanel`
- **vehicles.tsx** — vehicle rows, the Veículo drill-in, and the Adicionar veículo dialog (`AddVehicleDialog`)
- **vehicle-plate.ts** — plate blur gating, silent-fill vs overwrite, create/patch bodies with `plateSourcedKeys`
- **vehicle-plate-fields.tsx** — shared plate + identity field stack (blur lookup, states, confirmations)
- **quote.tsx** — Montar orçamento dialog: opens on the stored row's options (no reuse prompt), oil cards, and the Tecfil filter slots — per-type chooser when a slot has two or more candidates, breakdown caption under each price, and a Portuguese warning per unresolved type; holds a newer row behind "Chegaram dados novos" while the attendant has edited
- **quote-research.tsx** — the dialog's status region (background-oil-research D17): one persistent `role="status"` sentence (loading, research under way, new search, the row's date, or the outcome), the manual and queue lines, the ticking `role="timer"` counter, and "Buscar novamente"
- **quote-copy.ts** — the dialog's payload-dependent Portuguese sentences (D17), pure
- **quote-dead-ends.tsx** — the three dead ends' ways out (D24): the missing volume's field and its "Guardar … para os próximos orçamentos?" prompt, the clarification's engine buttons and "Corrigir versão do veículo", and the `radiogroup` a conflict's grade or volume is chosen from
- **vehicle-research-line.tsx** — the rail row's and the drill-in's "Pesquisando lubrificante…" line, read from `vehicle.oilResearch` (D18)
- **quote-sources.tsx** — the dialog's source lines: one `Fonte:` line when every grade and the volume share a source, one line per source otherwise, and each oil card's own grade source (D11, owner 2026-09-25). Never in the customer message.
- **schedule.tsx** — Programar mensagem dialog (form only) plus the service and scheduled-message rail rows
- **prefill.tsx** — field-level assistive suggestions (`FieldSuggestion`, `SuggestedVehicleRow`, `PendingFieldActions`) and the per-field Omie pendências diff panel (`OmiePendenciasPanel`)
