import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  port: Number(process.env.PORT) || 3001,
  // Localhost only by design. This app is single user and must not be
  // exposed publicly; it fronts a real brokerage account.
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.join(serverRoot, "data"),
  dbPath: path.join(serverRoot, "data", "app.db"),
};
