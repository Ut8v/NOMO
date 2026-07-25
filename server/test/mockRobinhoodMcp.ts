// Mock Robinhood Trading MCP for tests and local runs. Never used in
// production; the app talks to it via the ROBINHOOD_MCP_URL override.
// Exposes the read tools with canned data plus place_equity_order, which
// records every call so tests can assert exactly what reached the broker.
import express from "express";
import type { Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface MockRobinhood {
  url: string;
  /** Arguments of every place_equity_order call, in order. */
  placedOrders: Record<string, unknown>[];
  /** Arguments of every cancel_equity_order call, in order. */
  cancelledOrders: Record<string, unknown>[];
  /** Arguments of every review_equity_order call, in order. */
  reviewedOrders: Record<string, unknown>[];
  /** When true, review_equity_order returns an error so placement aborts. */
  reviewShouldFail: boolean;
  close: () => Promise<void>;
}

const READ_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown>; result: unknown }[] = [
  {
    name: "get_accounts",
    description: "List Robinhood accounts",
    inputSchema: { type: "object", properties: {} },
    result: { accounts: [{ account_number: "MOCK0001", type: "agentic", buying_power: "1523.11" }] },
  },
  {
    name: "get_portfolio",
    description: "Portfolio summary",
    inputSchema: { type: "object", properties: {} },
    result: { equity: "5271.81", market_value: "3748.70", buying_power: "1523.11" },
  },
  {
    name: "get_equity_positions",
    description: "Open equity positions",
    inputSchema: { type: "object", properties: {} },
    result: {
      positions: [
        { symbol: "AAPL", quantity: "12", average_buy_price: "201.55", market_value: "2836.20", side: "long" },
        { symbol: "NVDA", quantity: "5", average_buy_price: "168.30", market_value: "912.50", side: "long" },
      ],
    },
  },
  {
    name: "get_equity_orders",
    description: "Order history",
    inputSchema: { type: "object", properties: {} },
    result: { orders: [{ symbol: "AAPL", side: "buy", quantity: "12", state: "filled", executed_at: "2026-07-01T14:31:02Z" }] },
  },
  {
    name: "get_equity_quotes",
    description: "Quotes for symbols",
    inputSchema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] },
    result: { quotes: [{ symbol: "AAPL", last_trade_price: "236.35" }] },
  },
  {
    name: "search",
    description: "Search instruments",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    result: { results: [{ symbol: "AAPL", name: "Apple Inc." }] },
  },
  {
    name: "get_pnl_trade_history",
    description: "Trade-by-trade realized P/L history",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    result: { trades: [{ symbol: "AAPL", realized_pnl: "125.50" }] },
  },
  {
    name: "add_to_watchlist",
    description: "Add symbols to a watchlist",
    inputSchema: { type: "object", properties: { name: { type: "string" }, symbols: { type: "array", items: { type: "string" } } } },
    result: { ok: true },
  },
  {
    name: "create_scan",
    description: "Create a new scan",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    result: { ok: true },
  },
];

export async function startMockRobinhood(port: number): Promise<MockRobinhood> {
  const placedOrders: Record<string, unknown>[] = [];
  const cancelledOrders: Record<string, unknown>[] = [];
  const reviewedOrders: Record<string, unknown>[] = [];
  const state = { reviewShouldFail: false };

  function buildServer(): Server {
    const server = new Server({ name: "mock-robinhood-trading", version: "0.0.1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...READ_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        {
          name: "place_equity_order",
          description: "Place an equity order in the agentic account",
          inputSchema: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              side: { type: "string", enum: ["buy", "sell"] },
              quantity: { type: "string" },
              order_type: { type: "string", enum: ["market", "limit"] },
              limit_price: { type: "string" },
            },
            required: ["symbol", "side", "quantity", "order_type"],
          },
        },
        {
          name: "review_equity_order",
          description: "Preview an equity order before placing it",
          inputSchema: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              side: { type: "string", enum: ["buy", "sell"] },
              quantity: { type: "string" },
              order_type: { type: "string", enum: ["market", "limit"] },
            },
            required: ["symbol", "side", "quantity", "order_type"],
          },
        },
        {
          name: "cancel_equity_order",
          description: "Cancel an existing equity order in the agentic account",
          inputSchema: {
            type: "object",
            properties: { order_id: { type: "string" } },
            required: ["order_id"],
          },
        },
        {
          // An options execution tool: must never register as a model tool.
          name: "place_option_order",
          description: "Place a real options order",
          inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (request.params.name === "review_equity_order") {
        reviewedOrders.push(args);
        if (state.reviewShouldFail) {
          return { content: [{ type: "text", text: "insufficient buying power" }], isError: true };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ estimated_cost: "236.35", buying_power_ok: true }) }],
        };
      }
      if (request.params.name === "cancel_equity_order") {
        cancelledOrders.push(args);
        return {
          content: [{ type: "text", text: JSON.stringify({ order_id: args.order_id, state: "cancelled" }) }],
        };
      }
      if (request.params.name === "place_equity_order") {
        placedOrders.push(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                order_id: `RH-MOCK-${placedOrders.length}`,
                state: "confirmed",
                symbol: args.symbol,
                side: args.side,
                quantity: args.quantity,
                order_type: args.order_type,
              }),
            },
          ],
        };
      }
      const tool = READ_TOOLS.find((t) => t.name === request.params.name);
      if (!tool) {
        return { content: [{ type: "text", text: `unknown tool ${request.params.name}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(tool.result) }] };
    });
    return server;
  }

  const app = express();
  app.use(express.json());
  app.post("/mcp/trading", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer: HttpServer = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  return {
    url: `http://127.0.0.1:${port}/mcp/trading`,
    placedOrders,
    cancelledOrders,
    reviewedOrders,
    get reviewShouldFail() {
      return state.reviewShouldFail;
    },
    set reviewShouldFail(value: boolean) {
      state.reviewShouldFail = value;
    },
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
