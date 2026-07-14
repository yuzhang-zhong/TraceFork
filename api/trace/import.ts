import {
  parseHumanPlaywrightTraceBundle,
  parseNormalizedTraceImport,
  parseWebArenaExecutionBundle,
} from "../../src/trajectoryImport.js";
import type { GuiTraceSourceType } from "../../src/projectTypes.js";
import type { ApiRequest, ApiResponse } from "../_supabase.js";
import { handleCorsPreflight, setJsonHeaders } from "../_supabase.js";

function headerValue(req: ApiRequest, name: string): string {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function sourceType(value: unknown): GuiTraceSourceType {
  return value === "webarena_execution_bundle" || value === "playwright_human_trace" || value === "normalized_json"
    ? value
    : "normalized_json";
}

function readStreamBody(req: ApiRequest): Promise<Buffer> {
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

async function requestPayload(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  const raw = await readStreamBody(req);
  if (raw.length === 0) return {};
  const text = raw.toString("utf8");
  return JSON.parse(text);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "POST") {
    res.status(405).json({ ok: false, errors: ["Use POST /api/trace/import"] });
    return;
  }

  try {
    const contentType = headerValue(req, "content-type");
    if (contentType.includes("application/json") || req.body) {
      const payload = await requestPayload(req);
      const requestedType = sourceType(payload.sourceType ?? payload.source_type);
      if (requestedType === "normalized_json") {
        const normalized = payload.payload ?? payload.task ?? payload.tasks ?? payload;
        const result = parseNormalizedTraceImport(normalized);
        res.status(result.ok ? 200 : 400).json(result);
        return;
      }

      const base64 = typeof payload.fileBase64 === "string" ? payload.fileBase64 : typeof payload.file_base64 === "string" ? payload.file_base64 : "";
      if (!base64) {
        res.status(400).json({ ok: false, sourceType: requestedType, errors: ["fileBase64 is required for zip imports"], warnings: [] });
        return;
      }
      const bytes = Buffer.from(base64, "base64");
      const fileName = typeof payload.fileName === "string" ? payload.fileName : typeof payload.file_name === "string" ? payload.file_name : "trajectory.zip";
      const result =
        requestedType === "playwright_human_trace"
          ? await parseHumanPlaywrightTraceBundle(bytes, fileName)
          : await parseWebArenaExecutionBundle(bytes, fileName);
      res.status(result.ok ? 200 : 400).json(result);
      return;
    }

    res.status(415).json({
      ok: false,
      errors: ["Send application/json with normalized payload or base64 zip fields"],
      warnings: [],
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      errors: [error instanceof Error ? error.message : "Trace import failed"],
      warnings: [],
    });
  }
}
