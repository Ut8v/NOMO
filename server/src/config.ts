import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Localhost only by design. This app is single user, has no auth of its own,
// and fronts a real brokerage account, so non-loopback binds are refused.
const host = process.env.HOST || "127.0.0.1";
const isLoopback =
  host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
if (!isLoopback) {
  console.error(`Refusing to bind to ${host}. HOST must be a loopback address.`);
  process.exit(1);
}

// Overridable so integration tests run against a throwaway database
// instead of the real local one.
const dataDir = process.env.NOMO_DATA_DIR || path.join(serverRoot, "data");

export const config = {
  port: Number(process.env.PORT) || 3001,
  host,
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  // Research specialists run on a cheaper model; synthesis and the skeptic use
  // the stronger anthropicModel above. Both go through the same provider layer.
  anthropicSpecialistModel: process.env.ANTHROPIC_SPECIALIST_MODEL || "claude-haiku-4-5",
  // Base URL overrides exist so tests can point at mock providers; the
  // Anthropic SDK reads ANTHROPIC_BASE_URL itself, this copy is for the
  // places that call fetch directly.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  polygonBaseUrl: process.env.POLYGON_BASE_URL || "https://api.polygon.io",
  robinhoodMcpUrl: process.env.ROBINHOOD_MCP_URL || "https://agent.robinhood.com/mcp/trading",
  // SEC EDGAR: two hosts (data.sec.gov for JSON APIs, www.sec.gov for the
  // ticker map and filing archives). SEC's fair-access policy asks for a
  // descriptive User-Agent identifying the app and a contact; set your own
  // contact via SEC_USER_AGENT, especially for heavier use.
  secDataBaseUrl: process.env.SEC_DATA_BASE_URL || "https://data.sec.gov",
  secWwwBaseUrl: process.env.SEC_WWW_BASE_URL || "https://www.sec.gov",
  secUserAgent: process.env.SEC_USER_AGENT || "NOMO trading app",
  dataDir,
  dbPath: path.join(dataDir, "app.db"),
};
