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

export const config = {
  port: Number(process.env.PORT) || 3001,
  host,
  dataDir: path.join(serverRoot, "data"),
  dbPath: path.join(serverRoot, "data", "app.db"),
};
