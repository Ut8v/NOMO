import express from "express";
import type { Express } from "express";
import { setupRouter } from "./routes/setup.js";
import { chatRouter } from "./routes/chat.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/setup", setupRouter);
  app.use("/api/chat", chatRouter);

  return app;
}
