import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";
import { sharedVitestConfig } from "../../vitest.shared.js";

export default mergeConfig(
  mergeConfig(viteConfig, sharedVitestConfig),
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: "./setupTests.ts",
      env: {
        VITE_SUPABASE_URL: "http://supabase.test",
        VITE_SUPABASE_ANON_KEY: "test-anon-key",
        VITE_MVP_LOGIN_EMAIL: "attendant-a@selectlub.example",
        VITE_MVP_LOGIN_PASSWORD: "test-mvp-password",
      },
    },
  }),
);
