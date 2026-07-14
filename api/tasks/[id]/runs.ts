import type { ApiRequest, ApiResponse } from "../../_supabase.js";
import { getTaskWithRuns, handleCorsPreflight, setJsonHeaders } from "../../_supabase.js";

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "GET") {
    res.status(405).json({ ok: false, errors: ["Use GET /api/tasks/:id/runs"] });
    return;
  }

  try {
    const id = param(req.query?.id);
    if (!id) {
      res.status(400).json({ ok: false, errors: ["task id is required"] });
      return;
    }
    const task = await getTaskWithRuns(id);
    if (!task) {
      res.status(404).json({ ok: false, errors: [`Task ${id} not found`] });
      return;
    }
    res.status(200).json({ ok: true, task, runs: task.traces });
  } catch (error) {
    res.status(500).json({
      ok: false,
      errors: [error instanceof Error ? error.message : "Task runs lookup failed"],
    });
  }
}
