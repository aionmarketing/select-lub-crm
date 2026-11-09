> Fonte de verdade: Notion — Modelagem de Dados — CRM Select Lub — sincronizado em 2026-08-27 (N donos por veículo + titular; #29). Emenda local 2026-08-29 (BR-01 / origem da conversa, #32) aplicada abaixo e **pendente de sync no Notion** — sobe junto com a change `conversation-origin-classification`. Emenda 2026-08-30 (CompatibilidadeMotul por make/year/model/version, OpenSpec `motul-compatibility-by-model`) aplicada abaixo e **sincronizada no Notion** na archive desta change.

## Entidades e campos-chave

### Unidade
- `id`
- nome
- identificador da empresa ou unidade no Omie
- número de WhatsApp e identificador da instância Evolution API associada
- situação
- timestamps

### Usuário
- `id`
- nome e e-mail
- credencial ou provedor de autenticação
- unidades permitidas
- situação
- timestamps

### Cliente
- `id`
- identificador externo do Omie (opcional)
- nome (Omie `razao_social` / display)
- nome e sobrenome (opcionais; `givenName` / `familyName`; Meta `fn` / `ln`; CRM-only — Omie não tem nomes partidos)
- CPF/CNPJ (opcional; identidade Omie, não enviado à Meta)
- unidade de referência (opcional)
- origem
- situação
- rua, número, bairro e complemento (opcionais; Omie `endereco` / `endereco_numero` / `bairro` / `complemento`; **não** matching Meta)
- cidade (opcional; Omie `cidade`; Meta `ct`)
- estado/UF (opcional; Omie `estado`; Meta `st`)
- CEP (opcional; Omie `cep`; Meta `zp`)
- país (opcional; ISO-2 minúsculo, ex. `br`; Omie `codigo_pais` `1058` → `br`; mapeador CAPI usa `br` se vazio)
- timestamps
- por campo cadastral **compartilhado com o Omie**: origem, versão local, versão externa, última sincronização e situação
- `mergedInto` (nullable; id do Cliente base após fusão; a operação de fusão continua GitHub #5)

Gênero e data de nascimento ficam de fora até haver fonte no Omie. `ctwa_clid` fica na Conversa.

### Telefone e e-mail
- valores brutos e normalizados
- origem
- indicação de principal
- timestamps
- telefone principal → Meta `ph`; e-mail principal → Meta `em`

### Veículo
- `id`
- identificador externo (opcional; `omieId`. Palpite: Omie não tem entidade veículo — GitHub #29 corrige este campo no tenant real)
- donos: N clientes; exatamente um titular. O contrato/`#9` ainda expõe um `customerId` = titular; N:N entra no #29
- placa (opcional)
- marca, modelo, versão e ano (quando disponíveis)
- quilometragem atual (opcional)
- origem e timestamps

### Serviço
- `id`
- identificador externo do Omie
- `customer_id`
- `vehicle_id` (opcional)
- `unit_id`
- origem, versão local, versão externa e situação de sincronização por atributo compartilhado
- descrição ou tipo
- data de execução
- situação
- valor (opcional)
- quilometragem (opcional)
- timestamps

### Item de serviço
- `id`
- `service_id`
- identificador externo de produto (opcional)
- descrição
- tipo, quantidade e valores (opcionais)
- dados do óleo (quando identificáveis)

### Compatibilidade Motul
- `id`
- marca, ano, modelo e versão (identidade do veículo na consulta, compartilhada entre clientes)
- especificação retornada pela API da Motul (viscosidade e classificação, por exemplo API/ACEA)
- data da consulta
- payload bruto (opcional)

### Catálogo interno de lubrificantes
- `id`
- marca
- linha ou nome do produto
- especificação compatível (viscosidade e classificação)
- preço vigente
- situação ativa
- timestamps

### Orçamento de troca de óleo
- `id`
- `customer_id`
- `vehicle_id`
- `conversation_id` (opcional)
- itens selecionados: referência ao catálogo, marca, tipo e preço no momento da cotação (congelados)
- texto final da mensagem gerada
- pessoa criadora
- timestamps

### Conversa
- `id`
- `customer_id` (opcional)
- `unit_id`
- `chat_key` (no 1:1: número do cliente normalizado; JID `@g.us` completo reservado para grupo futuro)
- identificador do número empresarial
- `source_type`: `AD`, `ORGANIC` ou `UNKNOWN` — `AD` só com evidência de anúncio; `ORGANIC` quando o cliente iniciou sem evidência (BR-01 emendada 2026-08-29); iniciada pela loja fica `UNKNOWN`; `UNKNOWN`/`ORGANIC` sobem para `AD`, nunca o contrário
- tipo (`ctwa`, `ads_context`, `customer_initiated`, `none`), referência protegida e timestamp da evidência (`source_evidence_at`, horário do WhatsApp)
- versão da regra de classificação (gravada em toda linha classificada; nula = nunca classificada)
- `ctwa_clid` (opcional)
- identificadores de campanha, conjunto e anúncio (opcionais; relatório/UI expõem só campanha — conjunto/anúncio ficam gravados sem exibição)
- `started_at`
- `first_inbound_at`
- `first_outbound_at` (opcional)
- `last_inbound_at` (opcional)
- `last_outbound_at` (opcional)
- `last_message_at`
- identificador da conexão Evolution API associada
- timestamps
- restrição única: `(whatsapp_connection_id, chat_key)` — `chat_key` é o telefone normalizado no 1:1 (o JID `@g.us` completo fica reservado como chave de grupo futuro); `remote_jid` é endereço de envio, não a chave

### Mensagem
- `id`
- `conversation_id`
- identificador externo da mensagem no provider
- `remote_jid` protegido (quando disponibilizado)
- direção
- tipo e conteúdo ou referência protegida
- timestamp do provedor
- timestamp de ingestão
- identificador da pessoa remetente (opcional)
- referência de resposta (opcional)
- situação
- timestamps de envio, entrega, leitura e falha
- `route` (EVOLUTION_BAILEYS, WHATSAPP_WEB_MANUAL ou WHATSAPP_CLOUD_API)
- restrição única: `(conversation_id, external_message_id)` — a conexão deriva da conversa

### Tag
- `id`
- nome
- cor (opcional)
- ordem
- situação ativa

### Histórico de tag na conversa
- `conversation_id`
- `tag_id`
- data e usuário de aplicação
- data e usuário de remoção (opcionais)

### Template
- `id`
- nome
- texto
- variáveis permitidas
- situação
- timestamps

### Regra de referência de intervalo
- `id` e versão
- critério (serviço, produto ou óleo)
- identificador do critério
- intervalo sugerido em dias ou meses
- prioridade
- vigência
- situação

### Mensagem programada
- `id`
- `customer_id`
- `conversation_id` (opcional)
- `service_id` (opcional)
- `template_id`
- conteúdo final aprovado
- data sugerida (opcional)
- origem da sugestão
- data e hora programadas
- fuso horário
- situação: programada, processando, enviada, cancelada ou falha
- chave de idempotência
- pessoa criadora
- timestamps relevantes

### Execução de sincronização
- fonte
- entidade
- janela
- cursor
- situação
- totais
- timestamps

### Erro de integração
- integração
- operação
- correlação
- código
- mensagem sanitizada
- possibilidade de retentativa
- tentativas
- resolução

### Pendência de reconciliação cadastral
- cliente
- campo afetado
- valor do CRM
- valor do Omie
- versões
- motivo
- estado
- pessoa responsável pela resolução
- timestamps
