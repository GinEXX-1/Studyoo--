import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { router } from "./routes.js";
import { fail } from "./http.js";

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" }, message: "ok" });
});

app.use("/api/v1", router);

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  const code = error.errorCode || "SERVER_ERROR";
  const message = error.message || "服务器暂时不可用。";
  return fail(res, status, code, message);
});

app.listen(config.port, () => {
  console.log(`Studyoo API running at http://localhost:${config.port}/api/v1`);
});
