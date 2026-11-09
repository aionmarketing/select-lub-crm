/**
 * Test design (testing-strategy)
 *
 * SUT: the classification→tier map and the committed blocklist
 * (packages/core/src/kernel/prisma/source-tier.ts, packages/core/src/kernel/prisma/oil-source-blocklist.ts). Pure; no HTTP,
 * no DB, no model.
 *
 * Oracle: web-search-source-adapter D3 and specs/quotes/oil-spec-web-search/spec.md — "The
 * searching model classifies each page and that classification sets its tier": the five
 * classes map to tiers 1–5, `other` is rejected, and a committed blocklist rejects a page
 * regardless of the model's classification.
 *
 * Axes
 *   T1 classification value — each of the five / `other` / unknown string / null
 *   B1 host vs pattern — exact / subdomain / wildcard label / lookalike suffix / unparseable
 *   B2 blocklist category — forum / social / video / marketplace / classifieds / farm
 *
 * Outputs: O1 the tier or null; O2 the blocking entry or null
 *
 * Sampled cells (one row per `it` or `test.each` row)
 *   five classes            | T1 | O1 1..5 | fails if the map drifts from the hierarchy
 *   `other`                 | T1 | O1 null | THE rejection: a page the model could not place
 *      has no rung on the ladder, so it must not be rankable at all
 *   unknown string, null    | T1 | O1 null | a hand-edited or legacy value cannot smuggle a tier
 *   exact + subdomain       | B1 | O2 hit  | a blocked site cannot be reached via a subdomain
 *   lookalike suffix        | B1 | O2 null | THE false-positive guard: notreddit.com is not
 *      reddit.com, and matching on a substring would silently drop a legitimate source
 *   wildcard label          | B1 | O2 hit
 *   unparseable             | B1 | O2 hit  | a source we cannot address is not a source
 *
 * Out of scope: whether the model's classification is *correct* for a given page (a human
 * reviews that in task 8.2); fetching; the adapter's ordering.
 */
import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_TIER,
  tierForClassification,
} from "./source-tier.js";
import { findBlock, hostOf, matchesDomain, oilSourceBlocklist } from "./oil-source-blocklist.js";

describe("classification → tier", () => {
  it.each([
    ["manufacturer_manual", 1],
    ["manufacturer_technical", 2],
    ["licensed_database", 3],
    ["lubricant_maker_guide", 4],
    ["aftermarket_catalog", 5],
  ] as const)("maps %s to tier %i", (classification, tier) => {
    expect(tierForClassification(classification)).toBe(tier);
  });

  it("covers exactly the five storable classes", () => {
    expect(Object.keys(CLASSIFICATION_TIER).sort()).toEqual([
      "aftermarket_catalog",
      "licensed_database",
      "lubricant_maker_guide",
      "manufacturer_manual",
      "manufacturer_technical",
    ]);
  });

  it("gives `other` no tier, so an unplaceable page cannot be ranked", () => {
    expect(tierForClassification("other")).toBeNull();
  });

  it.each([["blog_post"], [""], [null], [undefined]])(
    "gives %s no tier",
    (value) => {
      expect(tierForClassification(value as string | null | undefined)).toBeNull();
    },
  );
});

describe("blocklist", () => {
  it("ships a non-empty list, every entry with a pattern and a reason", () => {
    const list = oilSourceBlocklist();

    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.pattern.trim()).not.toBe("");
      expect(entry.reason.trim()).not.toBe("");
    }
  });

  it.each([
    ["https://reddit.com/r/carros/x", "forum"],
    ["https://www.reddit.com/r/carros/x", "forum"],
    ["https://old.reddit.com/r/carros/x", "forum"],
    ["https://facebook.com/grupo", "social network"],
    ["https://youtube.com/watch?v=1", "video platform"],
    ["https://produto.mercadolivre.com.br/x", "marketplace"],
    ["https://www.webmotors.com.br/x", "classifieds"],
    ["https://algum.blogspot.com/post", "personal blog"],
  ])("blocks %s as %s", (url, reason) => {
    const block = findBlock(url);

    expect(block).not.toBeNull();
    expect(block?.reason).toBe(reason);
  });

  it.each([
    ["https://vw.com.br/manual"],
    ["https://honda.com.br/pos-venda"],
    ["https://carrorac.com/oleo-motor/volkswagen/polo.html"],
  ])("does not block %s", (url) => {
    expect(findBlock(url)).toBeNull();
  });

  it("does not block a lookalike that merely ends with a blocked name", () => {
    // Substring matching would kill this legitimate host; label matching must not.
    expect(findBlock("https://notreddit.com/page")).toBeNull();
    expect(findBlock("https://myfacebook.com.br/page")).toBeNull();
  });

  it("treats an unparseable URL as blocked", () => {
    expect(findBlock("not a url")).not.toBeNull();
  });

  it("matches on label boundaries, not substrings", () => {
    expect(matchesDomain("reddit.com", "reddit.com")).toBe(true);
    expect(matchesDomain("old.reddit.com", "reddit.com")).toBe(true);
    expect(matchesDomain("notreddit.com", "reddit.com")).toBe(false);
    expect(matchesDomain("reddit.com.br", "reddit.com")).toBe(false);
  });

  it("strips www and lowercases the host", () => {
    expect(hostOf("https://WWW.Example.COM/x")).toBe("example.com");
  });
});
