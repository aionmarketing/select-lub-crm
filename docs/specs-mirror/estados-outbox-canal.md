> Fonte de verdade: Notion — Especificação Técnica — Canal WhatsApp: Evolution API, Outbox e Roteamento — sincronizado em 2026-08-24

## Máquina de estados da outbox

```
  draft ─▶ queued ─▶ claimed ─▶ sent ─▶ confirmed
             │          │         │
             │          └─▶ failed ─▶ queued (retentativa com backoff)
             └─▶ blocked ──▶ queued (após recuperação da conexão)
                    │
                    └─▶ cancelled (ação da pessoa usuária)
```

- `draft` → `queued` → `claimed` → `sent` → `confirmed`
- `failed` → `queued` (retentativa com backoff)
- `blocked` → `queued` (após recuperação da conexão)
- `blocked` → `cancelled` (ação da pessoa usuária)
- `confirmed` exige um `external_message_id` associado

## Estados da conexão

| Estado | Significado | Comportamento do CRM |
| --- | --- | --- |
| `CONNECTING` | Instância em pareamento ou reconexão. | Envios ficam aguardando; a operação vê o estado. |
| `CONNECTED` | Sessão aberta e apta a enviar e receber. | Outbox pode ser despachada. |
| `DEGRADED` | Há falha parcial, atraso de eventos ou erro recuperável. | Novos envios exigem confirmação da saúde ou ficam bloqueados, conforme o erro. |
| `DISCONNECTED` | Sessão fechada, removida ou precisa de novo pareamento. | Nenhum envio automático; itens ficam `blocked` e o CRM oferece WhatsApp Web como contingência manual. |
