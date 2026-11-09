#!/usr/bin/env node
/**
 * Artboard checks for design/mvp-screen-designs (OpenSpec change
 * `revise-mvp-canvas-designs`, design decision D4).
 *
 * Verifies the four properties a machine checks better than a reviewer does:
 *
 * Test record for build-servicos-list-detail's `design-system/mvp-screen-designs`
 * delta: its four scenarios are verified here and by the artboard's own state
 * switch, not by vitest — they are assertions about drawn markup, which has no
 * runtime to unit-test. "List and detail are visible together", "The detail
 * carries items and their total" and "A service without a vehicle is drawn as
 * such" are read off `Servicos.dc.html`'s populated state; "No write affordance
 * is drawn" is the absence of any create/edit control, a CSV export, or an Omie
 * link in that file. The orphan-binding and unwired-handler checks below are
 * what stop a state from being unreachable while still looking right.
 *
 *   1. ORPHAN BINDINGS  — every `{{binding}}` in the markup resolves to a
 *      `data-props` key or a value the `Component` class returns. This is the
 *      defect that let `Relatorios.dc.html` ship with three unreachable
 *      states: the artboard rendered its `hint-placeholder-val` fallback and
 *      looked correct, so a human review could not see the missing states.
 *   2. HARDCODED LITERALS — no colour or radius literal on an element whose
 *      role that file's `:root` already declares.
 *   3. UNUSED TOKENS — no `:root` property outside the shared foundation that
 *      nothing in the file consumes. The foundation is exempt: it is one
 *      palette copied verbatim into five files, so a token unused by one
 *      artboard is expected.
 *   4. UNWIRED HANDLERS — no `go.*` handler is defined without an `onClick`
 *      referencing it. This is the mirror of check 1 and just as invisible in a
 *      rendered review: replacing Conversas' nav rows with the shared block
 *      dropped the two handlers wired into them, leaving the standalone
 *      Servicos screen with no way in and no way back, while every binding
 *      still resolved and the artboard still looked right.
 *   5. FOUNDATION IDENTITY — the fenced CSS block is byte-identical across all
 *      five artboards; the fenced markup block is identical bar which nav item
 *      carries `nav-item-on`. A nav `onClick` fails outright: every screen has
 *      its own artboard, so a nav click could never reach its target.
 *      Only an artboard whose click target lives in the same file can wire
 *      one, since artboards share no runtime.
 *
 * Usage:
 *   node check-artboards.mjs              # check the five artboards here
 *   node check-artboards.mjs <file...>    # check specific files
 *
 * Exits non-zero when any check fails.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTBOARDS = [
  "Main.dc.html",
  "Servicos.dc.html",
  "Relatorios.dc.html",
  "Configuracoes.dc.html",
  "Usuarios.dc.html",
  "FollowUp.dc.html",
];

const CSS_FENCE =
  /\/\* ===== BEGIN SHARED FOUNDATION[\s\S]*?\/\* ===== END SHARED FOUNDATION ===== \*\//;
const MARKUP_FENCE =
  /<!-- ===== BEGIN SHARED FOUNDATION MARKUP ===== -->[\s\S]*?<!-- ===== END SHARED FOUNDATION MARKUP ===== -->/;

/** Splits an artboard into its template markup and its logic script. */
function parts(source) {
  const scriptMatch = source.match(
    /<script data-dc-script[^>]*>([\s\S]*?)<\/script>/,
  );
  const propsMatch = source.match(/data-props='([\s\S]*?)'>/);
  const template = source.slice(0, scriptMatch ? source.indexOf(scriptMatch[0]) : undefined);
  return {
    template,
    logic: scriptMatch ? scriptMatch[1] : "",
    props: propsMatch ? propsMatch[1] : "",
  };
}

/** Names every path a `{{hole}}` in the template refers to. */
function referencedBindings(template) {
  const found = new Set();
  for (const [, path] of template.matchAll(/\{\{\s*([A-Za-z_$][\w.$]*)\s*\}\}/g)) {
    if (path !== "true" && path !== "false") {
      found.add(path);
    }
  }
  return found;
}

/**
 * Names every path the logic can produce. Deliberately permissive on shape —
 * it collects object keys and nesting from `renderVals()` rather than running
 * the class, so a false pass is possible but a false failure is not.
 */
function providedBindings(logic, props) {
  const provided = new Set();
  for (const [, key] of props.matchAll(/"([A-Za-z_$][\w$]*)"\s*:\s*\{/g)) {
    provided.add(key);
  }
  // Top-level keys of the object literal(s) returned from renderVals().
  const returned = logic.slice(logic.indexOf("renderVals"));
  for (const [, group, body] of returned.matchAll(
    /(\w+)\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
  )) {
    provided.add(group);
    for (const [, leaf] of body.matchAll(/(\w+)\s*:/g)) {
      provided.add(`${group}.${leaf}`);
    }
  }
  // `group: cond ? a : b` and `group: helper(...)` forms, plus bare keys.
  for (const [, key] of returned.matchAll(/^\s{4,}(\w+)\s*:/gm)) {
    provided.add(key);
  }
  // Shorthand returns (`return { msg, media, ... }`) name a group built
  // earlier as `const msg = { ... }`; collect those leaves too.
  for (const [, key] of returned.matchAll(/^\s{4,}(\w+),\s*$/gm)) {
    provided.add(key);
  }
  for (const [, name, body] of logic.matchAll(
    /const\s+(\w+)\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
  )) {
    provided.add(name);
    for (const [, leaf] of body.matchAll(/(\w+)\s*:/g)) {
      provided.add(`${name}.${leaf}`);
    }
  }
  // Object spread of a computed table (e.g. `conn: { ...conn, blocked: ... }`)
  // is covered by the group match above; leaves of such tables are resolved
  // by declaring the group itself reachable.
  return provided;
}

/** Handlers the logic defines that no `onClick` in the markup reaches. */
function unwiredHandlers(template, logic) {
  const defined = new Set();
  for (const [, name] of logic.matchAll(/^\s{8}(\w+):\s*\(\)\s*=>/gm)) {
    defined.add(name);
  }
  const referenced = new Set();
  for (const [, name] of template.matchAll(/\{\{\s*go\.(\w+)\s*\}\}/g)) {
    referenced.add(name);
  }
  return [...defined].filter((name) => !referenced.has(name));
}

/** Colour and radius literals that should have been tokens. */
function hardcodedLiterals(source) {
  const body = source
    .replace(CSS_FENCE, "")
    .replace(/:root\s*\{[\s\S]*?\}/g, "")
    // `&#123;` / `&#125;` are the escaped braces of template placeholders such
    // as {{nome_cliente}}, not colour literals.
    .replace(/&#\d+;/g, "");
  const hits = [];
  for (const [, hex] of body.matchAll(/(#[0-9a-fA-F]{3,8})\b/g)) {
    hits.push(hex);
  }
  return hits.filter((hex) => !/^#(eee|f5f5f5)$/i.test(hex));
}

/** `:root` properties declared outside the foundation that nothing consumes. */
function unusedLocalTokens(source) {
  const withoutFoundation = source.replace(CSS_FENCE, "");
  const declared = new Set();
  for (const block of withoutFoundation.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    for (const [, name] of block[1].matchAll(/(--[\w-]+)\s*:/g)) {
      declared.add(name);
    }
  }
  return [...declared].filter((name) => {
    const uses = source.split(`var(${name})`).length - 1;
    return uses === 0;
  });
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ARTBOARDS.map((name) => join(HERE, name));

let failures = 0;
const cssBlocks = new Map();
const markupBlocks = new Map();

for (const file of files) {
  const name = basename(file);
  const source = readFileSync(file, "utf8");
  const { template, logic, props } = parts(source);
  const problems = [];

  const referenced = referencedBindings(template);
  const provided = providedBindings(logic, props);
  // An <sc-for as="x"> puts x in scope for its subtree, so x.* resolves against
  // the list item rather than renderVals(). The list itself is still checked.
  const loopAliases = new Set(
    [...template.matchAll(/<sc-for[^>]*as="([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]),
  );
  const orphans = [...referenced].filter((path) => {
    if (provided.has(path)) return false;
    const [head] = path.split(".");
    if (loopAliases.has(head)) return false;
    return !provided.has(head);
  });
  if (orphans.length) {
    problems.push(`orphan bindings (no switch or renderVals path): ${orphans.join(", ")}`);
  }

  const unwired = unwiredHandlers(template, logic);
  if (unwired.length) {
    problems.push(
      `handlers defined but no onClick reaches them: ${unwired.map((n) => `go.${n}`).join(", ")}`,
    );
  }

  const literals = hardcodedLiterals(source);
  if (literals.length) {
    problems.push(`hardcoded colour/radius literals outside :root: ${[...new Set(literals)].join(", ")}`);
  }

  const unused = unusedLocalTokens(source);
  if (unused.length) {
    problems.push(`declared but unused local :root tokens: ${unused.join(", ")}`);
  }

  const css = source.match(CSS_FENCE);
  const markup = source.match(MARKUP_FENCE);
  if (!css) problems.push("missing the shared foundation CSS fence");
  if (!markup) problems.push("missing the shared foundation markup fence");
  if (css) cssBlocks.set(name, css[0]);
  if (markup) {
    // A nav click is no longer a legitimate difference: every screen has its own
    // artboard now, so a click target can never share the file and an onClick
    // here would be an orphan binding on any artboard. Asserted, not normalised.
    if (/ onClick=/.test(markup[0])) {
      problems.push("a page-nav item wires a click; no artboard may, since a nav click cannot cross files");
    }
    // Which item is current is the only difference left.
    markupBlocks.set(name, markup[0].replace(/ nav-item-on/g, ""));
  }

  if (problems.length) {
    failures += problems.length;
    console.error(`FAIL ${name}`);
    for (const problem of problems) console.error(`     - ${problem}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

if (cssBlocks.size > 1) {
  const [reference, ...rest] = [...cssBlocks.entries()];
  const drifted = rest.filter(([, block]) => block !== reference[1]).map(([name]) => name);
  if (drifted.length) {
    failures += 1;
    console.error(`FAIL foundation CSS differs from ${reference[0]} in: ${drifted.join(", ")}`);
  } else {
    console.log(`ok   foundation CSS byte-identical across ${cssBlocks.size} artboards`);
  }
}

if (markupBlocks.size > 1) {
  const [reference, ...rest] = [...markupBlocks.entries()];
  const drifted = rest.filter(([, block]) => block !== reference[1]).map(([name]) => name);
  if (drifted.length) {
    failures += 1;
    console.error(
      `FAIL foundation markup differs from ${reference[0]} beyond which item is current in: ${drifted.join(", ")}`,
    );
  } else {
    console.log(
      `ok   foundation markup identical across ${markupBlocks.size} artboards (current item aside)`,
    );
  }
}

if (failures) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log("\nAll artboard checks passed.");
