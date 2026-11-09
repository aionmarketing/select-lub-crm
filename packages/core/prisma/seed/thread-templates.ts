/**
 * Checked-in pt-BR workshop scripts. Slots fill from the planned ficha or from
 * a distractor that was already checked against that ficha. No language model.
 */
import { seedMessageExternalId, type PlannedSeedMessage } from "./history.js";
import { faker } from "./faker.js";
import type { ThreadArchetype } from "./thread-archetypes.js";

/** Cadastro facts the seed will (or will not) store on this conversation. */
export type StoredCadastro = {
  readonly name: string | null;
  readonly plate: string | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly street: string | null;
  readonly extraMake: string | null;
  readonly extraModel: string | null;
  readonly extraYear: number | null;
  readonly chatKey: string;
};

/** Values interpolated into trap templates. Each disagrees with {@link StoredCadastro}. */
export type TrapDistractors = {
  readonly plate: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly name: string;
  readonly phone: string;
  readonly street: string;
  readonly shop: string;
  readonly relation: string;
};

type ScriptLine = {
  readonly direction: "inbound" | "outbound";
  readonly text: string;
};

const MAKES = ["Chevrolet", "Fiat", "Honda", "Toyota", "Hyundai", "Jeep"] as const;
const MODELS = ["Onix", "Cronos", "Civic", "Corolla", "HB20", "Renegade"] as const;
const RELATIONS = ["esposa", "filho", "amigo"] as const;
const DISTRACTOR_SUFFIX = "XSEED";
const MAX_DRAW_ATTEMPTS = 8;

const SCRIPTS: Record<ThreadArchetype, readonly ScriptLine[]> = {
  bareHours: [
    { direction: "inbound", text: "Oi, vocês abrem que horas hoje?" },
    { direction: "inbound", text: "E sábado, funciona normalmente?" },
    { direction: "inbound", text: "Onde fica a loja, por favor?" },
  ],
  truePositive: [
    { direction: "inbound", text: "Oi, sou {{name}}. Preciso trocar o óleo do {{make}} {{model}} {{year}}." },
    { direction: "outbound", text: "Claro. Qual a placa do veículo?" },
    { direction: "inbound", text: "A placa é {{plate}}." },
    { direction: "outbound", text: "Perfeito, você está na ficha. Tem vaga hoje à tarde." },
    { direction: "inbound", text: "Pode ser. Está com uns 42 mil km." },
    { direction: "outbound", text: "Pode trazer. Fazemos a troca completa." },
    { direction: "inbound", text: "Combinado, obrigado." },
    { direction: "outbound", text: "Até mais, qualquer coisa é só chamar." },
  ],
  formerVehicle: [
    { direction: "inbound", text: "Vocês ainda têm o histórico do {{distractorMake}} {{distractorModel}} {{distractorYear}}?" },
    { direction: "outbound", text: "Vou olhar aqui. É o carro da ficha?" },
    { direction: "inbound", text: "Não, aquele eu já vendi. Era o antigo." },
    { direction: "outbound", text: "Entendi. O atual é outro, então." },
    { direction: "inbound", text: "Isso. Só queria a data da última troca do antigo." },
    { direction: "outbound", text: "Te retorno com o que aparecer no sistema." },
  ],
  familyCar: [
    { direction: "inbound", text: "{{relation}} quer trazer o {{distractorMake}} {{distractorModel}} {{distractorYear}}." },
    { direction: "outbound", text: "Pode. É o mesmo da sua ficha?" },
    { direction: "inbound", text: "Não, é o carro dela, não é o meu." },
    { direction: "outbound", text: "Beleza, agendamos no nome de quem vier." },
    { direction: "inbound", text: "Pode deixar. Ela chega no fim da tarde." },
    { direction: "outbound", text: "Estamos te esperando." },
  ],
  thirdPartyPlate: [
    { direction: "inbound", text: "Achei uma placa {{distractorPlate}} no pátio, acho que não é minha." },
    { direction: "outbound", text: "Consegue confirmar se alguém da família reconhece?" },
    { direction: "inbound", text: "Ninguém aqui. Deve ser de outro cliente." },
    { direction: "outbound", text: "Obrigado por avisar, a gente guarda no achados." },
    { direction: "inbound", text: "Beleza. Se aparecer o dono, me avisam?" },
    { direction: "outbound", text: "Avisamos sim." },
  ],
  someoneElseNamePhone: [
    { direction: "inbound", text: "Pode falar com {{distractorName}} no {{distractorPhone}}, não sou eu quem resolve." },
    { direction: "outbound", text: "É o contato da ficha ou outra pessoa?" },
    { direction: "inbound", text: "Outra pessoa. É o mecânico que cuida disso." },
    { direction: "outbound", text: "Certo, anoto o recado para ele." },
    { direction: "inbound", text: "Valeu. Ele confirma o horário." },
    { direction: "outbound", text: "Fico no aguardo." },
  ],
  destinationNotHome: [
    { direction: "inbound", text: "Vou estar na {{distractorStreet}} amanhã, não é em casa." },
    { direction: "outbound", text: "Precisa de endereço da loja ou é só um recado?" },
    { direction: "inbound", text: "Recado. Se atrasar, me acha lá, não no endereço cadastrado." },
    { direction: "outbound", text: "Combinado, não usamos o endereço de casa então." },
    { direction: "inbound", text: "Isso. Depois passo aí." },
    { direction: "outbound", text: "Te esperamos." },
  ],
  otherShopQuote: [
    { direction: "inbound", text: "A {{distractorShop}} cobrou 280 no 5W-30 com filtro, vocês fazem por quanto?" },
    { direction: "outbound", text: "Esse valor é de outra oficina. Aqui monto o orçamento na nossa tabela." },
    { direction: "inbound", text: "Pode mandar o de vocês então, o deles eu só encaminhei." },
    { direction: "outbound", text: "Te envio o nosso, sem copiar o número deles." },
    { direction: "inbound", text: "Beleza, obrigado." },
    { direction: "outbound", text: "Já te retorno." },
  ],
  leftoverScheduling: [
    { direction: "inbound", text: "Tem horário quinta de manhã para uma revisão rápida?" },
    { direction: "outbound", text: "Temos 9h e 11h. Qual fica melhor?" },
    { direction: "inbound", text: "Pode ser 9h." },
    { direction: "outbound", text: "Reservado. Chega uns 10 minutos antes." },
    { direction: "inbound", text: "Combinado, até quinta." },
  ],
  leftoverReturn: [
    { direction: "inbound", text: "Já faz uns seis meses da última troca. Preciso voltar?" },
    { direction: "outbound", text: "Sim, o intervalo usual é esse. Quer agendar o retorno?" },
    { direction: "inbound", text: "Quero. Semana que vem de tarde pode ser?" },
    { direction: "outbound", text: "Terça ou quarta, 14h." },
    { direction: "inbound", text: "Quarta 14h." },
    { direction: "outbound", text: "Anotado. Te esperamos." },
  ],
  leftoverPriceCheck: [
    { direction: "inbound", text: "Quanto está a troca completa hoje, sem compromisso?" },
    { direction: "outbound", text: "Depende do óleo. Te passo duas opções da prateleira." },
    { direction: "inbound", text: "Pode ser a mais em conta." },
    { direction: "outbound", text: "Fechamos a linha de entrada e o filtro." },
    { direction: "inbound", text: "Tá bom. Depois confirmo se venho." },
    { direction: "outbound", text: "Fico no aguardo." },
    { direction: "inbound", text: "Valeu." },
  ],
};

const BLURBS: Record<ThreadArchetype, string> = {
  bareHours: "Pergunta de horário, sábado e onde fica a loja",
  truePositive: "Troca de óleo do veículo que está na ficha",
  formerVehicle: "Histórico de um carro antigo que já foi vendido",
  familyCar: "Agendamento do carro de um familiar, não o da ficha",
  thirdPartyPlate: "Placa encontrada no pátio que não é a da ficha",
  someoneElseNamePhone: "Recado para outra pessoa resolver o atendimento",
  destinationNotHome: "Aviso de que estará em outro endereço, não em casa",
  otherShopQuote: "Preço encaminhado de outra oficina para comparar",
  leftoverScheduling: "Marcação de horário para uma revisão",
  leftoverReturn: "Retorno depois do intervalo da última troca",
  leftoverPriceCheck: "Pedido de preço da troca completa, sem agendar",
};

const IDENTIFIER_TOKENS = new Set([
  "{{plate}}",
  "{{make}}",
  "{{model}}",
  "{{year}}",
  "{{name}}",
  "{{distractorPlate}}",
  "{{distractorMake}}",
  "{{distractorModel}}",
  "{{distractorYear}}",
  "{{distractorName}}",
  "{{distractorPhone}}",
  "{{distractorStreet}}",
  "{{distractorShop}}",
  "{{relation}}",
]);

/**
 * One-line description of a filled archetype, for the gitignored mix summary.
 *
 * @param archetype - The primary or leftover script on that conversation.
 */
export function blurbForArchetype(archetype: ThreadArchetype) {
  return BLURBS[archetype];
}

/**
 * Picks a value that does not match the stored fact, then a reserved suffix.
 *
 * @param generate - Next faker (or test) candidate.
 * @param matches - True when the candidate equals the stored cadastro.
 * @param fallback - Reserved seed suffix appended when every draw collides.
 */
export function pickDisagreeingValue(input: {
  generate: () => string;
  matches: (value: string) => boolean;
  fallback: string;
  maxAttempts?: number;
}) {
  const attempts = input.maxAttempts ?? MAX_DRAW_ATTEMPTS;
  for (let i = 0; i < attempts; i += 1) {
    const value = input.generate();
    if (!input.matches(value)) {
      return value;
    }
  }
  const last = input.generate();
  const suffixed = `${last}${input.fallback}`;
  return input.matches(suffixed) ? `${suffixed}${DISTRACTOR_SUFFIX}` : suffixed;
}

export function normalizePlate(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export function normalizePersonName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeStreet(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeVehicle(make: string, model: string, year: number) {
  return `${make} ${model} ${year}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseVehicleToken(raw: string, forbidden: readonly string[]) {
  const [make, model, yearToken] = raw.split("|");
  const year = Number(yearToken);
  if (make && model && Number.isFinite(year) && !forbidden.includes(normalizeVehicle(make, model, year))) {
    return { make, model, year };
  }
  return { make: "SeedMarca", model: "SeedModelo", year: 1999 };
}

function storedVehicles(stored: StoredCadastro) {
  const rows: string[] = [];
  if (stored.make && stored.model && stored.year != null) {
    rows.push(normalizeVehicle(stored.make, stored.model, stored.year));
  }
  if (stored.extraMake && stored.extraModel && stored.extraYear != null) {
    rows.push(normalizeVehicle(stored.extraMake, stored.extraModel, stored.extraYear));
  }
  return rows;
}

/**
 * Draws trap slots from the demo faker stream and rejects a hit on the ficha.
 *
 * When there is no customer, the phone-only identity is the chat key. A reserved
 * suffix is appended if every draw still collides.
 *
 * @param stored - Facts this conversation will store (or its chat key).
 * @param draw - Source of candidates; callers continue the demo faker stream.
 */
export function drawTrapDistractors(
  stored: StoredCadastro,
  draw: typeof faker = faker,
): TrapDistractors {
  const storedPlate = stored.plate ? normalizePlate(stored.plate) : "";
  const storedPhone = normalizePhone(stored.chatKey);
  const storedName = stored.name ? normalizePersonName(stored.name) : "";
  const storedStreet = stored.street ? normalizeStreet(stored.street) : "";
  const vehicles = storedVehicles(stored);

  const plate = pickDisagreeingValue({
    generate: () => draw.string.alphanumeric({ length: 7, casing: "upper" }),
    matches: (value) => {
      const normalized = normalizePlate(value);
      return normalized === storedPlate || normalized === storedPhone;
    },
    fallback: DISTRACTOR_SUFFIX,
  });

  const vehicleOk = pickDisagreeingValue({
    generate: () => {
      const nextMake = MAKES[draw.number.int({ min: 0, max: MAKES.length - 1 })]!;
      const nextModel = MODELS[draw.number.int({ min: 0, max: MODELS.length - 1 })]!;
      const nextYear = draw.number.int({ min: 2010, max: 2024 });
      return `${nextMake}|${nextModel}|${nextYear}`;
    },
    matches: (value) => {
      const [nextMake, nextModel, nextYear] = value.split("|");
      return vehicles.includes(normalizeVehicle(nextMake!, nextModel!, Number(nextYear)));
    },
    fallback: DISTRACTOR_SUFFIX,
  });
  const parsedVehicle = parseVehicleToken(vehicleOk, vehicles);

  const name = pickDisagreeingValue({
    generate: () => `${draw.person.firstName()} ${draw.person.lastName()}`,
    matches: (value) => {
      const normalized = normalizePersonName(value);
      return normalized === storedName || normalizePhone(value) === storedPhone;
    },
    fallback: DISTRACTOR_SUFFIX,
  });

  const phone = pickDisagreeingValue({
    generate: () => `55${draw.string.numeric(11)}`,
    matches: (value) => normalizePhone(value) === storedPhone,
    fallback: DISTRACTOR_SUFFIX,
  });

  const street = pickDisagreeingValue({
    generate: () => `Rua ${draw.location.street()}`,
    matches: (value) => {
      const normalized = normalizeStreet(value);
      return normalized === storedStreet || normalizePhone(value) === storedPhone;
    },
    fallback: DISTRACTOR_SUFFIX,
  });

  const shop = pickDisagreeingValue({
    generate: () => draw.company.name(),
    matches: (value) => normalizePersonName(value) === storedName,
    fallback: DISTRACTOR_SUFFIX,
  });

  const relation = RELATIONS[draw.number.int({ min: 0, max: RELATIONS.length - 1 })]!;

  return {
    plate,
    make: parsedVehicle.make,
    model: parsedVehicle.model,
    year: parsedVehicle.year,
    name,
    phone,
    street,
    shop,
    relation,
  };
}

/**
 * Internet-Portuguese register: strip accents and apply a fixed abbreviation table.
 *
 * Identifier placeholders (`{{plate}}` and the other slots) are left untouched
 * so a true-positive plate stays exactly the stored plate.
 *
 * @param text - Template line, still carrying `{{slots}}`.
 */
export function applyInternetPortugueseTypos(text: string) {
  return text.split(/({{[a-zA-Z]+}})/).map((part) => {
    if (IDENTIFIER_TOKENS.has(part)) {
      return part;
    }
    return part
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\bvoce\b/gi, "vc")
      .replace(/\bpara\b/gi, "pra")
      .replace(/\besta\b/gi, "ta")
      .replace(/\btambem\b/gi, "tbm")
      .replace(/\bpor favor\b/gi, "pfv");
  }).join("");
}

function slotValues(stored: StoredCadastro, distractors: TrapDistractors): Record<string, string> {
  return {
    "{{plate}}": stored.plate ?? "",
    "{{make}}": stored.make ?? "",
    "{{model}}": stored.model ?? "",
    "{{year}}": stored.year == null ? "" : String(stored.year),
    "{{name}}": stored.name ?? "",
    "{{distractorPlate}}": distractors.plate,
    "{{distractorMake}}": distractors.make,
    "{{distractorModel}}": distractors.model,
    "{{distractorYear}}": String(distractors.year),
    "{{distractorName}}": distractors.name,
    "{{distractorPhone}}": distractors.phone,
    "{{distractorStreet}}": distractors.street,
    "{{distractorShop}}": distractors.shop,
    "{{relation}}": distractors.relation,
  };
}

function fillSlots(text: string, values: Record<string, string>) {
  return text.replace(/{{[a-zA-Z]+}}/g, (token) => values[token] ?? token);
}

/**
 * Renders one archetype's lines with slots filled and optional typos.
 *
 * @param input.archetype - Which checked-in script to use.
 * @param input.stored - Ficha facts (true-positive) or nulls for pré-cadastro.
 * @param input.distractors - Already-disagreeing trap values.
 * @param input.applyTypos - When true, the register transform runs on non-identifier text.
 */
export function renderWorkshopThread(input: {
  archetype: ThreadArchetype;
  stored: StoredCadastro;
  distractors: TrapDistractors;
  applyTypos: boolean;
}) {
  const values = slotValues(input.stored, input.distractors);
  const lines = SCRIPTS[input.archetype].map((line) => {
    const templated = input.applyTypos ? applyInternetPortugueseTypos(line.text) : line.text;
    return { direction: line.direction, text: fillSlots(templated, values) };
  });
  return { lines, blurb: BLURBS[input.archetype] };
}

/**
 * Turns a rendered workshop script into the `SEED` rows {@link seedFakeHistory} writes.
 *
 * Bare-hours is inbound-only (`shouldReply: true`). Other archetypes mix in a reply
 * so a quote may sit on them. `includeOutbound` on the plumbing input is ignored.
 *
 * @param input.anchor - Time the last seeded message lands on.
 */
export function planWorkshopSeedThread(input: {
  conversationId: string;
  anchor: Date;
  archetype: ThreadArchetype;
  stored: StoredCadastro;
  distractors: TrapDistractors;
  applyTypos: boolean;
}): PlannedSeedMessage[] {
  const { lines } = renderWorkshopThread(input);
  const hasOutbound = lines.some((line) => line.direction === "outbound");
  return lines.map((line, index) => {
    const n = index + 1;
    return {
      n,
      externalMessageId: seedMessageExternalId(input.conversationId, n),
      direction: line.direction,
      textBody: line.text,
      providerTimestamp: new Date(input.anchor.getTime() - (lines.length - n) * 3 * 60_000),
      shouldReply: line.direction === "inbound" && !hasOutbound ? true : null,
    };
  });
}

/** Length band the spec allows for a bare-hours thread. */
export const BARE_THREAD_LENGTH = { min: 1, max: 4 } as const;

/** Length band the spec allows for every other filled archetype. */
export const NON_BARE_THREAD_LENGTH = { min: 5, max: 20 } as const;
