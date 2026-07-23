// Mock Robinhood Trading MCP server for local testing. Serves a handful of
// read tools with canned data plus one execution tool that must NEVER be
// registered by the app (the allowlist test). No auth, stateless transport.
// Usage: node server/test/mock-robinhood-mcp.mjs [port]
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.argv[2]) || 9097;

const POSITIONS = [
  { symbol: "AAPL", quantity: "12", average_buy_price: "201.55", market_value: "2836.20", side: "long" },
  { symbol: "NVDA", quantity: "5", average_buy_price: "168.30", market_value: "912.50", side: "long" },
];

const TOOLS = [
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
    result: { positions: POSITIONS },
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
    name: "place_equity_order",
    description: "EXECUTION TOOL: must never be registered by the app in Phase 4",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    result: { error: "should never be callable" },
  },
];

function buildServer() {
  const server = new Server({ name: "mock-robinhood-trading", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
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

app.listen(PORT, "127.0.0.1", () => console.log(`mock robinhood mcp on ${PORT}`));
