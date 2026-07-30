import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "../lib/cache.js";
import { checkPython3Available } from "../lib/startupCheck.js";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  let database = false;
  try {
    db.prepare("SELECT 1").get();
    database = true;
  } catch {
    database = false;
  }

  const pythonValidator = await checkPython3Available();
  const aiConfigured = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);

  const data = HealthCheckResponse.parse({
    status: database ? "ok" : "degraded",
    database,
    pythonValidator,
    aiConfigured,
  });
  res.json(data);
});

export default router;
