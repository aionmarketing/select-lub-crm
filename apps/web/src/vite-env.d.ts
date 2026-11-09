/**
 * Vite `import.meta.env` typings and references for theme augmentation.
 */
/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference types="vite/client" />
/// <reference path="./theme.d.ts" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_UI_VARIANT?: string;
  readonly VITE_UNIT_ID?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_MVP_LOGIN_EMAIL?: string;
  readonly VITE_MVP_LOGIN_PASSWORD?: string;
}
