import type { ApiRequest, ApiResponse } from "./_supabase.js";
import { compareRunIds, handleCorsPreflight, setJsonHeaders } from "./_supabase.js";

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "GET") {
    res.status(405).json({ ok: false, errors: ["Use GET /api/compare?runA=...&runB=..."] });
    return;
  }

  try {
    const runA = queryValue(req.query?.runA);
    const runB = queryValue(req.query?.runB);
    if (!runA || !runB) {
      res.status(400).json({ ok: false, errors: ["runA and runB query params are required"] });
      return;
    }
    const result = await compareRunIds(runA, runB);
    if (!result) {
      res.status(404).json({ ok: false, errors: ["Runs were not found in the same task"] });
      return;
    }
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      errors: [error instanceof Error ? error.message : "Comparison failed"],
    });
  }
}
