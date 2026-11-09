/**
 * Whether the production web search can run right now: `WEB_SEARCH_ENABLED` is not `false` and
 * the search key (`OPENAI_API_KEY`, the research model's own) is set — the web adapter's own "not
 * searched" rule. The runner's heartbeat records it (background-oil-research, review of #188), so
 * a quote-open re-opens a no-source recorded "not searched" only while a search could actually
 * run.
 */
export function webSearchAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_SEARCH_ENABLED !== "false" && Boolean(env.OPENAI_API_KEY?.trim());
}
