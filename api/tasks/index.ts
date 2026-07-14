import type { ApiRequest, ApiResponse } from "../_supabase.js";
import { handleCorsPreflight, searchTasks, setJsonHeaders } from "../_supabase.js";

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "GET") {
    res.status(405).json({ ok: false, errors: ["Use GET /api/tasks"] });
    return;
  }

  try {
    const query = queryValue(req.query?.query ?? req.query?.q);
    const tasks = await searchTasks(query);
    res.status(200).json({ ok: true, tasks, source: process.env.SUPABASE_URL ? "supabase" : "local-fixture" });
  } catch (error) {
    res.status(500).json({
      ok: false,
      tasks: [],
      errors: [error instanceof Error ? error.message : "Task search failed"],
    });
  }
}
