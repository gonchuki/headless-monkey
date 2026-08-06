import express from "express";

export interface HealthResponse {
  status: "ok";
}

export function createApp(): express.Express {
  const app = express();

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { status: "ok" };
    res.status(200).json(body);
  });

  return app;
}
