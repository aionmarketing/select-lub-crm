# motul-agent

Internal LLM helper that calls Motul tools. Not attendant-facing HTTP yet.

- **index.ts** — public export: `runMotulAgent`
- **loop.ts** — `generateText` loop (model, stop, history cap)
- **prompt.ts** — system instructions
- **tools.ts** — `findOil` tool wired to the Motul client (`kernel/clients/motul`)
