import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// Core's scopes, as boundary elements. Elements match FOLDERS, not files -- a
// pattern ending in `index.ts` silently classifies nothing, which is how a
// cross-slice import first got past this config. Order matters: the first match
// wins, so the narrower folders are listed before the ones that contain them.
const coreElements = [
  { type: "kernel", pattern: "packages/core/src/kernel/**", partialMatch: false },
  { type: "shared", pattern: "packages/core/src/shared/**", partialMatch: false },
  {
    type: "testing",
    pattern: "packages/core/src/testing/**",
    partialMatch: false,
  },
  {
    type: "contracts",
    pattern: "packages/core/src/modules/*/contracts/**",
    partialMatch: false,
    capture: ["module"],
  },
  {
    type: "internal",
    pattern: "packages/core/src/modules/*/internal/**",
    partialMatch: false,
    capture: ["module"],
  },
  {
    type: "slice-tests",
    pattern: "packages/core/src/modules/*/*/tests/**",
    partialMatch: false,
    capture: ["module", "slice"],
  },
  {
    type: "slice",
    pattern: "packages/core/src/modules/*/*/**",
    partialMatch: false,
    capture: ["module", "slice"],
  },
  // Files directly in a module folder: its `index.ts` and its AGENTS.md
  // sibling code. Listed last of the module patterns, so the scopes above
  // claim theirs first.
  {
    type: "mod-index",
    pattern: "packages/core/src/modules/*",
    partialMatch: false,
    capture: ["module"],
  },
];

// The plugin resolves specifiers through eslint-module-utils, whose default
// (eslint-import-resolver-node) cannot follow this repo's NodeNext imports:
// every internal import is written `./thing.js` and the file on disk is
// `thing.ts`. Without the TypeScript resolver the specifier resolves to
// nothing, the dependency is treated as external, and every rule passes on any
// import at all -- which is exactly what happened when a deliberate
// cross-slice import was first tried against this config and eslint reported
// no error. The apps' tsconfigs are listed so `@select-lub/core/...` resolves
// from them to core's files, where the elements below can classify it.
const boundaryResolver = {
  typescript: {
    project: [
      "packages/core/tsconfig.test.json",
      "apps/api/tsconfig.json",
      "apps/api/tsconfig.test.json",
      "apps/worker/tsconfig.json",
      "apps/worker/tsconfig.test.json",
      "apps/web/tsconfig.json",
      "apps/web/tsconfig.test.json",
      "apps/e2e/tsconfig.json",
    ],
    // One project per app is deliberate: each app resolves core through its own
    // tsconfig, the way its build does.
    noWarnOnMultipleProjects: true,
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/ts-dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/blob-report/**",
      "**/node_modules/**",
      // Sibling checkouts of this same repository. git excludes them
      // (.git/info/exclude), but eslint does not read that file, so without
      // this every developer holding a worktree lints another branch's tree
      // and `pnpm lint` fails locally while CI, which has no worktrees, passes.
      "**/.worktrees/**",
      "**/.vite/**",
      "**/.claude/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Module boundaries: inside packages/core/src (this block), and from the apps
  // into core (the next block, wave 5.4).
  //
  // The scopes, and the one rule that orders them: imports point OUTWARD. A
  // slice may reach its own module's internal and public scopes and any
  // module's public scope; `internal` may reach its own module's public scope;
  // nothing outside a module reaches its internals or its slices; the kernel
  // reaches no module at all. Everything below is that sentence, spelled for
  // the linter.
  // ---------------------------------------------------------------------------
  {
    files: ["packages/core/src/**/*.ts"],
    // The package barrel is the package's public entry, not one of the scopes.
    // It is excluded rather than given an element of its own because the plugin
    // matches elements by directory: the only pattern that claims a file
    // directly under `src/` is `packages/core/src/**`, and as a catch-all that
    // would make `no-unknown-files` vacuous -- every stray file would match it.
    // Keeping the rule strict is worth more than boundary-checking one file
    // whose three imports are all downward anyway.
    // src/contracts.ts (5.1d) is the web-safe entry, excluded for the same reason.
    ignores: ["packages/core/src/index.ts", "packages/core/src/contracts.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": coreElements,
      "boundaries/ignore": ["**/*.d.ts"],
      "import/resolver": boundaryResolver,
    },
    rules: {
      // A file under packages/core/src that matches no element above is a file
      // nobody decided the scope of. Failing is the point.
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "{{from.type}} may not import {{to.type}}. Imports point outward only: a slice reaches its own module's internal/ and any module's contracts/, never another slice or another module's internal/. See packages/core/src/modules/README.md.",
          policies: [
            // The kernel is the bottom. It may reach itself and the shared
            // kernel, and no module, ever.
            {
              from: [{ element: { type: "kernel" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
              ],
            },
            {
              from: [{ element: { type: "shared" } }],
              allow: [{ to: { element: { type: "shared" } } }],
            },
            // The harness is test infrastructure; it may use the kernel.
            {
              from: [{ element: { type: "testing" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "testing" } } },
              ],
            },
            // A module's public surface. Importable by anyone; may itself reach
            // only downward, never into its own slices.
            {
              from: [{ element: { type: "contracts" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "contracts" } } },
              ],
            },
            // A module's internals: its own public scope, and other modules'.
            {
              from: [{ element: { type: "internal" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "contracts" } } },
                {
                  to: {
                    element: {
                      type: "internal",
                      captured: { module: "{{from.module}}" },
                    },
                  },
                },
              ],
            },
            // The module index wires its own slices together.
            {
              from: [{ element: { type: "mod-index" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "contracts" } } },
                {
                  to: {
                    element: {
                      type: "internal",
                      captured: { module: "{{from.module}}" },
                    },
                  },
                },
                {
                  to: {
                    element: { type: "slice", captured: { module: "{{from.module}}" } },
                  },
                },
              ],
            },
            // A slice: the kernel, the shared kernel, any module's contracts,
            // its OWN module's internals, and its OWN files. Not another slice,
            // not another module's internals.
            {
              from: [{ element: { type: "slice" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "contracts" } } },
                {
                  to: {
                    element: {
                      type: "internal",
                      captured: { module: "{{from.module}}" },
                    },
                  },
                },
                {
                  to: {
                    element: {
                      type: "slice",
                      captured: { module: "{{from.module}}", slice: "{{from.slice}}" },
                    },
                  },
                },
              ],
            },
            // A slice's tests go through its entry point or its rules file,
            // which is what keeps a test from pinning an internal shape.
            {
              from: [{ element: { type: "slice-tests" } }],
              allow: [
                { to: { element: { type: "kernel" } } },
                { to: { element: { type: "shared" } } },
                { to: { element: { type: "testing" } } },
                { to: { element: { type: "contracts" } } },
                {
                  to: {
                    element: {
                      type: "slice",
                      captured: { module: "{{from.module}}", slice: "{{from.slice}}" },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
      // A slice is one use case. When a file outgrows the limit it splits into
      // schema.ts / handler.ts / rules.ts / queries.ts / <dependency>.ts, with
      // index.ts as the barrel -- the split is forced, not remembered.
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  // ---------------------------------------------------------------------------
  // The apps (wave 5.4). Each is a composition root: it may import its own
  // files, `@select-lub/shared-types`, and core only through core's PUBLISHED
  // entries -- the barrel, `/contracts`, `/db`, `/testing`, `/modules/<m>` and
  // `/modules/<m>/contracts` -- never a deep kernel or module path, and never
  // another app. apps/web runs in the browser and takes none of core at all:
  // it reaches core's web contracts only through `@select-lub/shared-types`,
  // which re-exports `@select-lub/core/contracts` (5.1d).
  //
  // "Published" is checked twice: the import must land on the element that
  // entry resolves to, AND be written as that entry's specifier. A relative
  // `../../packages/core/src/kernel/db.js` lands on `kernel` like
  // `@select-lub/core/db` does, and only the specifier tells them apart.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        ...coreElements,
        { type: "app", pattern: "apps/*/**", partialMatch: false, capture: ["app"] },
        { type: "shared-types", pattern: "packages/shared-types/**", partialMatch: false },
        // The schema, migrations and demo seed under packages/core/prisma: no app's to import.
        { type: "core-prisma", pattern: "packages/core/prisma/**", partialMatch: false },
        // core's two entry files directly in src/: the barrel (`index.ts`) and
        // the web-safe contracts entry (`contracts.ts`, 5.1d). Only here, as a
        // target: in the block above, a folder element for src/ would also
        // claim any stray src/ subfolder and make no-unknown-files vacuous there.
        // The specifier, checked below, says which of the two an import means.
        { type: "core-entry", pattern: "packages/core/src", partialMatch: false },
      ],
      "boundaries/ignore": ["**/*.d.ts"],
      "import/resolver": boundaryResolver,
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "apps/{{from.captured.app}} may not import {{to.type}} as \"{{dependency.source}}\". An app imports its own files, @select-lub/shared-types, and core only through @select-lub/core, /contracts, /db, /testing, /modules/<m> or /modules/<m>/contracts; apps/web takes none of core (its contracts arrive through @select-lub/shared-types). See eslint.config.js.",
          policies: [
            {
              from: [{ element: { type: "app" } }],
              allow: [
                { to: { element: { type: "app", captured: { app: "{{from.app}}" } } } },
                { to: { element: { type: "shared-types" } } },
              ],
            },
            {
              from: [{ element: { type: "app", captured: { app: "{api,worker,e2e}" } } }],
              allow: [
                { to: { element: { type: "core-entry" } }, dependency: { source: "@select-lub/core" } },
                { to: { element: { type: "core-entry" } }, dependency: { source: "@select-lub/core/contracts" } },
                { to: { element: { type: "kernel" } }, dependency: { source: "@select-lub/core/db" } },
                { to: { element: { type: "testing" } }, dependency: { source: "@select-lub/core/testing" } },
                { to: { element: { type: "mod-index" } }, dependency: { source: "@select-lub/core/modules/*" } },
                {
                  to: { element: { type: "contracts" } },
                  dependency: { source: "@select-lub/core/modules/*/contracts" },
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // A handler is glue: parse, call rules, map the result. Sixty lines is the
    // point at which it has started doing the work itself.
    files: ["packages/core/src/modules/*/*/handler.ts"],
    rules: {
      "max-lines": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // rules.ts is the pure core of a slice: no database, no clock, no network.
    // Those arrive as arguments.
    files: ["packages/core/src/modules/*/*/rules*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message: "rules.ts is pure; take the data as an argument.",
            },
            {
              name: "@select-lub/core/db",
              message: "rules.ts is pure; take the data as an argument.",
            },
          ],
          patterns: [
            {
              group: ["**/queries.js", "**/queries.ts"],
              message: "rules.ts is pure; take the data as an argument.",
            },
            {
              group: ["**/kernel/db.js", "**/kernel/db.ts", "**/kernel/prisma/**"],
              message: "rules.ts is pure; take the data as an argument.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message: "rules.ts is pure; take the current time as an argument.",
        },
        { name: "fetch", message: "rules.ts is pure; the caller does the I/O." },
      ],
    },
  },
  {
    // The web contract (5.1d): every module's `contracts/http*.ts` is re-exported by
    // `@select-lub/core/contracts`, which `@select-lub/shared-types` hands to the
    // browser bundle. So a web contract may import only `zod`, its own module's
    // `http.<topic>` files, another module's `contracts/http.js`, and `shared/web/`
    // — never Prisma, Fastify, `pg`, `node:*`, the kernel, or a sibling contract
    // that reaches them. Enforced per FILE, like rules.ts below, because the
    // boundary elements above classify folders. packages/core/test/web-contracts
    // walks the actual graph from `src/contracts.ts` as the second line.
    files: ["packages/core/src/modules/*/contracts/http*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:zod|\\./http\\.[a-z-]+\\.js|\\.\\./\\.\\./[a-z-]+/contracts/http\\.js|\\.\\./\\.\\./\\.\\./shared/web/[a-z-]+\\.js)$)",
              message:
                "A web contract reaches the browser bundle: import only zod, ./http.<topic>.js, ../../<module>/contracts/http.js or ../../../shared/web/<file>.js.",
            },
          ],
        },
      ],
    },
  },
  {
    // shared/web/: the shared kernel's web vocabulary, reached by the same bundle.
    files: ["packages/core/src/shared/web/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!(?:zod|\\./[a-z-]+\\.js)$)",
              message: "shared/web reaches the browser bundle: import only zod and ./<sibling>.js.",
            },
          ],
        },
      ],
    },
  },
  {
    // Both web scopes: no dynamic `import()` or `require()` at all. The bundler
    // follows them just like a static import, and no-restricted-imports above
    // only sees static ones. The web-contracts walk catches them too.
    files: ["packages/core/src/modules/*/contracts/http*.ts", "packages/core/src/shared/web/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "A web contract reaches the browser bundle: no dynamic import(); use a static import of zod, an http contract or shared/web.",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: "A web contract reaches the browser bundle: no require().",
        },
      ],
    },
  },
  {
    // Names that describe nothing. Banned as files and as folders, so a slice
    // that needs a new part has to say what the part is.
    files: [
      "packages/core/src/**/{utils,helpers,common,types,misc,lib}.ts",
      "packages/core/src/**/{utils,helpers,common,types,misc,lib}/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message:
            "`utils`, `helpers`, `common`, `types`, `misc` and `lib` are banned as file and folder names. Name the thing after what it does.",
        },
      ],
    },
  },
);
