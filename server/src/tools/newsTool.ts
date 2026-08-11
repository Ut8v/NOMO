import { getNews } from "../services/polygon.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/**
 * Recent news headlines for a ticker, from Polygon (free tier, existing key).
 * Read-only market_data tier. Any sentiment comes straight from the source;
 * the model interprets the headlines.
 */
export function registerNewsTool(): void {
  registerTool({
    name: "get_news",
    tier: "market_data",
    description:
      "Get recent news headlines for a stock: title, publisher, date, article link, and the source's sentiment when available. Use to find catalysts and gauge the current narrative around a ticker.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        limit: { type: "number", description: "How many recent articles to return (1 to 25, default 10)" },
      },
      required: ["ticker"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const raw = (input ?? {}) as { ticker?: unknown; limit?: unknown };
      const ticker = (typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "");
      if (!TICKER_PATTERN.test(ticker)) throw new Error("ticker must be a stock symbol like AAPL.");
      const limit = typeof raw.limit === "number" ? raw.limit : undefined;
      const articles = await getNews(ticker, limit ?? 10);
      return { forModel: { ticker, count: articles.length, articles } };
    },
  });
}
