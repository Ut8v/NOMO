import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

let db: Database.Database | null = null;

/**
 * Opens the local SQLite database, creating the file and schema on first run.
 * Called once at server startup.
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  const firstRun = !fs.existsSync(config.dbPath);

  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);

  if (firstRun) {
    console.log(`Created local database at ${config.dbPath}`);
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() at startup.");
  }
  return db;
}
