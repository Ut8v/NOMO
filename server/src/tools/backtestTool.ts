import { runBacktest } from "../services/backtest.js";
import type { StrategyName, StrategyParams } from "../services/backtest.js";
import { registerTool } from "./registry.js";
import type { ToolExecutionResult } from "./registry.js";

/**
 * Backtests a simple, named rule over a ticker's daily history and returns
 * deterministic metrics. The model picks the rule and its parameters; all
 * numbers are computed in TypeScript, so it interprets results, never fabricates
 * them. Read-only market_data tier: it touches no account and places no order.
 */
export function registerBacktestTool(): void {
  registerTool({
    name: "backtest_strategy",
    tier: "market_data",
    description:
      "Backtest a simple rule against a ticker's daily price history and get its return, buy-and-hold return, number of trades, win rate, average trade return, and max drawdown. Strategies: buy_and_hold; sma_crossover (params fast, slow); price_vs_sma (param period); rsi_reversion (params period, oversold, overbought). Long-only, no lookahead. Use it to sanity-check whether a thesis or setup has actually worked historically.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock symbol, e.g. AAPL" },
        strategy: {
          type: "string",
          enum: ["buy_and_hold", "sma_crossover", "price_vs_sma", "rsi_reversion"],
        },
        params: {
          type: "object",
          description: "Strategy parameters. fast/slow for sma_crossover, period for price_vs_sma, period/oversold/overbought for rsi_reversion.",
          properties: {
            fast: { type: "number" },
            slow: { type: "number" },
            period: { type: "number" },
            oversold: { type: "number" },
            overbought: { type: "number" },
          },
        },
        lookback_days: { type: "number", description: "Daily history window, 30 to 1825 (default 365)" },
      },
      required: ["ticker", "strategy"],
    },
    execute: async (input): Promise<ToolExecutionResult> => {
      const raw = (input ?? {}) as {
        ticker?: unknown;
        strategy?: unknown;
        params?: unknown;
        lookback_days?: unknown;
      };
      const ticker = typeof raw.ticker === "string" ? raw.ticker : "";
      const strategy = raw.strategy as StrategyName;
      const params = (raw.params && typeof raw.params === "object" ? raw.params : {}) as StrategyParams;
      const lookbackDays = typeof raw.lookback_days === "number" ? raw.lookback_days : undefined;
      return { forModel: await runBacktest(ticker, { strategy, params, lookbackDays }) };
    },
  });
}
