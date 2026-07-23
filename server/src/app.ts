import express from "express";
import type { Express } from "express";
import { setupRouter } from "./routes/setup.js";
import { chatRouter } from "./routes/chat.js";
import { robinhoodRouter } from "./routes/robinhood.js";
import { settingsRouter } from "./routes/settings.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/setup", setupRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/robinhood", robinhoodRouter);
  app.use("/api/settings", settingsRouter);

  return app;
}
