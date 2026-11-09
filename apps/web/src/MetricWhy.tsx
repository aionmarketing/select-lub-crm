/**
 * The mark that explains what a Relatórios metric — or a Relatórios section —
 * counts, plus the detail the PDF artboard parks behind that same mark.
 *
 * The approved canvas replaced a "Detalhe" section at the foot of the screen
 * with this: each explanation lives on the metric it explains, behind a small
 * mark beside that metric's label. The section was a cellar of leftovers, and
 * collapsing it made the metrics inside look less important than the ones
 * above. The PDF export went one step further: the pieces that used to be
 * cards of their own — the period table, the attribution window, the
 * median/p90 lines, the campaign rows — are now the `detail` this hook renders
 * under the explanation.
 *
 * No `REP-xx` identifier appears anywhere — not at rest, not in the revealed
 * text, not in a class name. Those identifiers are the specification's
 * vocabulary, not the vocabulary of the person reading a report.
 */
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";
import { TYPE_SCALE, TOUCH_TARGET_PX } from "./theme.js";

/**
 * What each metric counts, in Portuguese, keyed by the metric's own label.
 *
 * Keyed by label rather than by an id so a card wires itself up: every card
 * already receives its label, and a metric with no entry here simply draws no
 * mark. The wording is the canvas's, which is why it explains the *decisions*
 * — which clock a figure obeys, what it excludes, why two were renamed —
 * rather than restating the label in longer words.
 *
 * The last two keys are the section headings Funil de Vendas and Tabela de
 * Origem, whose marks sit in the heading row rather than on a card.
 */
export const METRIC_EXPLANATIONS: Record<string, string> = {
  "Total de Leads":
    "Conversas iniciadas no período, contadas pela hora da primeira mensagem do cliente no WhatsApp — não pela hora em que o CRM importou a conversa.",
  "Taxa de Conversão":
    "Das conversas do período ligadas a um cliente, a fatia que virou serviço. Conversas sem cliente ficam de fora da conta, não entram como zero.",
  "Receita Gerada":
    "Soma do valor dos serviços de origem Omie atribuídos a conversas do período e realizados dentro dele.",
  "Tempo Médio de Resposta":
    "Média do tempo entre a primeira mensagem do cliente e a primeira resposta da equipe, em tempo corrido — horário comercial não entra no MVP.",
  "Conversas sem resposta no período":
    'Conversas do período com uma mensagem do cliente marcada como "pede resposta" e nenhuma saída depois dela. Não confundir com o alerta no topo, que é deste momento e não do período.',
  "Taxa de Aprovação":
    "Orçamentos enviados no período cujo envio é seguido por um serviço de origem Omie daquele cliente dentro da janela de atribuição. Sem orçamento enviado, fica ausente — nunca 0% nem 100%.",
  "Clientes perdidos no período":
    "Clientes cujo retorno venceu dentro do período e que não voltaram. Renomeado: enquanto o número obedece ao filtro, ele conta um evento do período — quem venceu agora — e não o estado geral da base, que seria outra métrica.",
  "Receita média por cliente":
    'Soma dos serviços de origem Omie do período, dividida pelos clientes que tiveram serviço nele. Renomeado: filtrar "valor de vida" por um mês produz receita média no mês, não valor de vida — o nome antigo passaria a mentir assim que o filtro passasse a valer.',
  "Funil de Vendas":
    "Quatro etapas encaixadas: cada uma conta as conversas da etapa anterior que avançaram, então nenhuma pode ser maior que a anterior. A linha de retenção mostra em que passo o funil perde mais.",
  "Tabela de Origem":
    "Uma linha por classificação de origem da conversa — anúncio, orgânica e desconhecida. A tabela não inventa linhas por rede ou por criativo; a quebra por campanha fica aqui embaixo.",
};

/**
 * Gives a card — or a section heading — the mark, the explanation, and the
 * detail the mark reveals, as separately placed elements.
 *
 * A hook rather than one component because the halves belong in different
 * places: the canvas puts the mark in the head row beside the label and the
 * text below the value. Returning them apart lets the caller position each
 * without lifting the open/closed state into the caller itself.
 *
 * Everything is `null`/`false` when the label has no entry, so an unexplained
 * metric is not given an empty affordance to click.
 *
 * @param label - The metric's or section's visible label, used as the lookup key.
 * @param detail - Optional node drawn under the explanation behind a hairline:
 *   the period table, the attribution sentence, the response-time lines, the
 *   campaign rows. Omit it for a metric whose mark reveals only prose.
 * @returns `mark` for the head row; `body` for the foot of a card (a collapse
 *   that opens under a hairline); `open` and `content` for a section, whose
 *   explanation is drawn as its own card between heading and section card.
 */
export function useMetricWhy(label: string, detail?: ReactNode) {
  const [open, setOpen] = useState(false);
  const text = METRIC_EXPLANATIONS[label];
  if (!text) {
    return { mark: null, body: null, content: null, open: false };
  }
  const content = (
    <>
      <Typography sx={{ fontSize: TYPE_SCALE.body, lineHeight: 1.5 }}>
        {text}
      </Typography>
      {detail ? (
        <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}>{detail}</Box>
      ) : null}
    </>
  );
  return {
    open,
    content,
    mark: (
      <IconButton
        size="small"
        aria-expanded={open}
        aria-label={`O que é ${label}`}
        onClick={() => setOpen((v) => !v)}
        sx={{
          minWidth: TOUCH_TARGET_PX,
          minHeight: TOUCH_TARGET_PX,
          fontSize: TYPE_SCALE.caption,
          fontWeight: 700,
          lineHeight: 1,
          color: open ? "text.primary" : "text.secondary",
          border: 1,
          borderColor: open ? "text.primary" : "divider",
        }}
      >
        i
      </IconButton>
    ),
    body: (
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}>{content}</Box>
      </Collapse>
    ),
  };
}
