import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { resetSessionRecoveryForTests, settleSessionRecoveryForTests } from "./src/AppProviders.js";
import { TEST_WEB_ACCESS_TOKEN, useAuthSession } from "./src/authSession.js";
import { server } from "./test/msw/server.js";

function seedLoggedInSession() {
  useAuthSession.setState({
    accessToken: TEST_WEB_ACCESS_TOKEN,
    currentUnitId: null,
    ready: true,
    // Reset explicitly, not left to default. These two are sticky by design —
    // `recoveryFailed` is terminal so that a refused recovery cannot loop — and
    // a store is module state that outlives a test. Without this, one test that
    // exercises a refused session leaves `recoveryFailed: true` behind and every
    // later test in the file silently skips recovery, which is exactly the kind
    // of order-dependent pass this suite should not have.
    recovering: false,
    recoveryFailed: false,
  });
}

beforeAll(() => {
  // jsdom implements neither; MessageList's target-message scroll needs it.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof URL.createObjectURL !== "function") {
    let serial = 0;
    URL.createObjectURL = () => `blob:http://localhost/${++serial}`;
    URL.revokeObjectURL = () => {};
  }
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  // Module state, not store state. A recovery left in flight by one test is
  // otherwise handed to the next as an already-settled promise, so its
  // `recoverSession()` returns without recovering — an order-dependent pass.
  resetSessionRecoveryForTests();
  seedLoggedInSession();
});

afterEach(async () => {
  // Unmount first, so the recovery handler is deregistered and nothing new can
  // start, then drain what is already running. Recovery is fire-and-forget by
  // design; without this drain it settles during the NEXT test and overwrites
  // that test's session state, which shows up as failures that move between
  // runs and disappear when the test is run alone.
  cleanup();
  await settleSessionRecoveryForTests();
  server.resetHandlers();
  seedLoggedInSession();
});

afterAll(() => {
  server.close();
});
