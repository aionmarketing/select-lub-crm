/**
 * What the conversation slices need from outside the database, handed in by the
 * api's composition root through `createHttpPlugin(ports)`.
 *
 * - `instanceName` and `channelConnected`: the configured Evolution instance and
 *   the LIVE connectivity probe — the send paths refuse on the probe, Nova
 *   conversa on the STORED column (the two-source rule stands).
 * - `fetchMedia`: the inbound media download from Evolution.
 * - `templateValues`: the customer name and titular plate a template preview
 *   interpolates. The api passes customers' `templateValuesFrom(cadastroStore)`
 *   (its `contracts/template-values.ts`), the old tags route's read unchanged.
 *
 * None of these is awaited inside a `db.tx` (W2-C12).
 */
import type { CadastroLink } from "../contracts/get-cadastro-link.js";

/** Downloads one media message's bytes from Evolution. */
export type FetchMediaPort = (input: {
  instanceName: string;
  externalMessageId: string;
  convertToMp4: boolean;
}) => Promise<{ ok: true; bytes: Uint8Array; mimeType: string | null; fileName: string | null } | { ok: false }>;

/** The two values a template preview can interpolate. */
export type TemplateValues = { nome_cliente: string | null; placa: string | null };

/** The conversation module's ports. */
export type ConversationsPorts = {
  /** The configured Evolution instance, resolved once at app construction. */
  instanceName: () => string;
  /** The LIVE probe; true when Evolution reports the session open. */
  channelConnected: () => Promise<boolean>;
  /** Evolution's media download. */
  fetchMedia: FetchMediaPort;
  /** The customer values for a thread, for a template preview. */
  templateValues: (unitId: string, link: CadastroLink) => Promise<TemplateValues>;
};
