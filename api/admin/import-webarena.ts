import {
  parseHumanPlaywrightTraceBundle,
  parseNormalizedTraceImport,
  parseWebArenaExecutionBundle,
} from "../../src/trajectoryImport.js";
import type { GuiTraceSourceType } from "../../src/projectTypes.js";
import type { ApiRequest, ApiResponse } from "../_supabase.js";
import { handleCorsPreflight, setJsonHeaders, upsertTasks } from "../_supabase.js";

function sourceType(value: unknown): GuiTraceSourceType {
  return value === "playwright_human_trace" || value === "webarena_execution_bundle" || value === "normalized_json"
    ? value
    : "webarena_execution_bundle";
}

function authorized(req: ApiRequest): boolean {
  const token = process.env.ADMIN_IMPORT_TOKEN;
  if (!token) return process.env.VERCEL_ENV !== "production";
  const auth = req.headers.authorization ?? req.headers.Authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  return value === `Bearer ${token}`;
}

async function readStreamBody(req: ApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    if (!req.on) {
      resolve(Buffer.alloc(0));
      return;
    }
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""))));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

async function payload(req: ApiRequest): Promise<Record<string, unknown>> {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString("utf8");
    return text.trim() ? JSON.parse(text) : {};
  }
  if (typeof req.body === "string") return req.body.trim() ? JSON.parse(req.body) : {};
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  const raw = await readStreamBody(req);
  if (!raw.length) throw new Error("empty request body");
  return JSON.parse(raw.toString("utf8"));
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "POST") {
    res.status(405).json({ ok: false, errors: ["Use POST /api/admin/import-webarena"] });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, errors: ["Unauthorized import request"] });
    return;
  }

  try {
    const body = await payload(req);
    const requestedType = sourceType(body.sourceType);
    const dryRun = body.dryRun === true;
    let imported;
    if (requestedType === "normalized_json") {
      imported = parseNormalizedTraceImport(body.payload ?? body.task ?? body.tasks ?? body);
    } else {
      const fileBase64 = typeof body.fileBase64 === "string" ? body.fileBase64 : "";
      if (!fileBase64) {
        res.status(400).json({ ok: false, errors: ["fileBase64 is required for zip import"], warnings: [] });
        return;
      }
      const fileName = typeof body.fileName === "string" ? body.fileName : "webarena-trajectory.zip";
      const bytes = Buffer.from(fileBase64, "base64");
      imported =
        requestedType === "playwright_human_trace"
          ? await parseHumanPlaywrightTraceBundle(bytes, fileName)
          : await parseWebArenaExecutionBundle(bytes, fileName);
    }

    if (!imported.ok) {
      res.status(400).json(imported);
      return;
    }

    const persistence = dryRun ? { persisted: false, dryRun: true } : await upsertTasks(imported.tasks);
    res.status(200).json({
      ok: true,
      sourceType: imported.sourceType,
      audit: imported.audit,
      warnings: imported.warnings,
      persistence,
      tasks: dryRun ? imported.tasks : undefined,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      errors: [error instanceof Error ? error.message : "Admin import failed"],
      warnings: [],
    });
  }
}
