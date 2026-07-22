import express from "express";
import type { Express } from "express";
import { setupRouter } from "./routes/setup.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/setup", setupRouter);

  return app;
}
