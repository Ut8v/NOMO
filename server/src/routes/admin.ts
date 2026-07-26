import { Router } from "express";
import { getTablePage, listBrowsableTables } from "../db/admin.js";

/**
 * Read-only database dashboard API. Localhost only, like the rest of the app.
 * It never exposes credential secrets: the db layer redacts them in SQL.
 */
export const adminRouter = Router();

adminRouter.get("/tables", (_req, res) => {
  res.json(listBrowsableTables());
});

adminRouter.get("/tables/:name", (req, res) => {
  const limit = Number(req.query.limit);
  const offset = Number(req.query.offset);
  try {
    const page = getTablePage(
      req.params.name,
      Number.isFinite(limit) ? limit : 50,
      Number.isFinite(offset) ? offset : 0,
    );
    res.json(page);
  } catch {
    res.status(404).json({ error: `No browsable table named ${req.params.name}.` });
  }
});
