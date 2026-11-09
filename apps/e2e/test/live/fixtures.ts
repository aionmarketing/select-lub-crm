/**
 * Playwright fixtures for live Programar mensagem. No e2e SQL seed, no Evolution mock.
 */
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { ConversasPage } from "../pages/conversas-page.js";
import { supabaseAccessToken } from "../fixtures.js";
import { ensureFreeLiveService } from "./ensure-service.js";
import type { LiveScheduleConversation } from "./gate.js";
import { LIVE_RUN_ID } from "./run-id.js";
import { resolveLiveScheduleContext } from "./resolve.js";

const apiBase = "http://127.0.0.1:3000";

type Fixtures = {
  conversasPage: ConversasPage;
  crmApi: APIRequestContext;
  liveConversation: LiveScheduleConversation;
  liveServiceId: string;
};

export const test = base.extend<Fixtures>({
  liveConversation: async ({ browserName }, use, testInfo) => {
    void browserName;
    const gate = await resolveLiveScheduleContext();
    if (gate.kind === "skip") {
      console.log(`live Programar mensagem skipped: ${gate.reason}`);
      testInfo.skip(true, gate.reason);
      return;
    }
    if (gate.kind === "fail") {
      throw new Error(gate.message);
    }
    await use(gate.conversation);
  },
  liveServiceId: async ({ liveConversation }, use) => {
    await use(await ensureFreeLiveService(liveConversation, LIVE_RUN_ID));
  },
  conversasPage: async ({ page }, use) => {
    await use(new ConversasPage(page));
  },
  crmApi: async ({ playwright, liveConversation }, use) => {
    const token = await supabaseAccessToken();
    const context = await playwright.request.newContext({
      baseURL: apiBase,
      extraHTTPHeaders: {
        Authorization: `Bearer ${token}`,
        "x-unit-id": liveConversation.unitId,
      },
    });
    await use(context);
    await context.dispose();
  },
});

export { expect };
