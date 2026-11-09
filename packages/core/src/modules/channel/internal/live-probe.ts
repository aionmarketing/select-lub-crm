/**
 * The api's thin Evolution client: the LIVE connectivity probe the send paths
 * read, and the inbound media download. Never sends.
 *
 * Moved from `apps/api/src/conversations/evolution.ts` (4A): channel owns Evolution.
 * The api's composition root passes these to the conversations and scheduling
 * plugins as ports. The worker's adapter (`evolution.ts`) reads the same
 * endpoints for its own reconcile; the two differ on purpose — this probe answers
 * false on missing config rather than refusing to construct — and are left
 * separate until wave 5 aligns them.
 */
import { resolveEvolutionInstanceName } from "./instance-name.js";

function evolutionConfig(options?: { baseUrl?: string; apiKey?: string }) {
  const baseUrl = (options?.baseUrl ?? process.env.SERVER_URL)?.replace(/\/$/, "");
  const apiKey = options?.apiKey ?? process.env.AUTHENTICATION_API_KEY;
  if (!baseUrl) {
    throw new Error("SERVER_URL is not set");
  }
  if (!apiKey) {
    throw new Error("AUTHENTICATION_API_KEY is not set");
  }
  return { baseUrl, apiKey };
}

/**
 * Returns true when the configured Evolution instance reports `open` connection state.
 *
 * @param options - Optional Evolution base URL, API key, and instance name; defaults from env vars.
 * @returns `true` when the instance state is `open`; `false` on error, missing env, or any other state.
 */
export async function fetchEvolutionConnected(options?: {
  baseUrl?: string;
  apiKey?: string;
  instanceName?: string;
}) {
  let baseUrl: string;
  let apiKey: string;
  try {
    ({ baseUrl, apiKey } = evolutionConfig(options));
  } catch {
    return false;
  }
  const instanceName = resolveEvolutionInstanceName(options?.instanceName);
  try {
    const response = await fetch(`${baseUrl}/instance/connectionState/${encodeURIComponent(instanceName)}`, {
      headers: { apikey: apiKey },
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { instance?: { state?: string }; state?: string };
    const state = body.instance?.state ?? body.state;
    return state === "open";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Downloads message media bytes from Evolution `getBase64FromMediaMessage`.
 *
 * @param input - Instance name, WhatsApp external message id, mp4 conversion flag, and optional REST overrides.
 * @returns Decoded bytes with mime/file metadata on success, or `{ ok: false }` on HTTP or parse failure.
 */
export async function fetchEvolutionMedia(input: {
  instanceName: string;
  externalMessageId: string;
  convertToMp4: boolean;
  baseUrl?: string;
  apiKey?: string;
}): Promise<
  { ok: true; bytes: Buffer; mimeType: string | null; fileName: string | null } | { ok: false }
> {
  let baseUrl: string;
  let apiKey: string;
  try {
    ({ baseUrl, apiKey } = evolutionConfig({ baseUrl: input.baseUrl, apiKey: input.apiKey }));
  } catch {
    return { ok: false };
  }
  try {
    const response = await fetch(`${baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(input.instanceName)}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { key: { id: input.externalMessageId } },
        convertToMp4: input.convertToMp4,
      }),
    });
    if (!response.ok) {
      return { ok: false };
    }
    const payload = asRecord(await response.json());
    const base64 = readString(payload?.base64);
    if (!base64) {
      return { ok: false };
    }
    return {
      ok: true,
      bytes: Buffer.from(base64, "base64"),
      mimeType: readString(payload?.mimetype),
      fileName: readString(payload?.fileName),
    };
  } catch {
    return { ok: false };
  }
}
