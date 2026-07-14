import { guiAgentTasks } from "../src/projectData.js";
import { analyzeGuiAgentTraces } from "../src/projectLogic.js";
import type { GuiAgentTask, GuiAgentTrace } from "../src/projectTypes.js";
import fs from "node:fs";
import path from "node:path";

type ApiRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, callback: (chunk?: unknown) => void) => void;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
};

export type { ApiRequest, ApiResponse };

type SupabaseTaskRow = {
  task_id: string;
  title: string;
  instruction: string;
  domain: string;
  start_url: string | null;
  success_criteria: string | null;
  risk_tags: string[] | null;
  text_state: string | null;
  visual_state: string | null;
  screenshot_width: number | null;
  screenshot_height: number | null;
  source_type: string | null;
  source_label: string | null;
  benchmark: GuiAgentTask["benchmark"] | null;
  task_numeric_id: string | null;
  site: string | null;
  source_collection: string | null;
  source_path: string | null;
};

type SupabaseRunRow = {
  trace_id: string;
  task_id: string;
  agent_id: string;
  agent_kind: GuiAgentTrace["agentKind"];
  model_id: string;
  source_type: GuiAgentTrace["sourceType"];
  source_label: string | null;
  source_warnings: string[] | null;
  benchmark: GuiAgentTrace["benchmark"] | null;
  site: string | null;
  source_collection: string | null;
  actor_type: GuiAgentTrace["actorType"] | null;
  prompt_setting: string | null;
  observation_mode: GuiAgentTrace["observationMode"] | null;
  outcome: GuiAgentTrace["outcome"] | null;
  source_path: string | null;
};

type SupabaseStepRow = {
  trace_id: string;
  step_index: number;
  observation_type: GuiAgentTrace["steps"][number]["observationType"];
  observation_summary: string;
  action_type: GuiAgentTrace["steps"][number]["actionType"];
  target_label: string;
  dom_selector: string | null;
  bbox: [number, number, number, number] | null;
  input_text: string | null;
  structured_rationale: string | null;
  confidence: number | null;
  state_after: string;
  url: string | null;
  screenshot_ref: string | null;
  thumbnail_ref: string | null;
  source_ref: string | null;
  source_html_path: string | null;
  visual_frame_available: boolean | null;
  adapter_confidence: GuiAgentTrace["steps"][number]["adapterConfidence"] | null;
  source_warnings: string[] | null;
};

function env(name: string): string {
  return process.env[name] ?? "";
}

export function hasSupabaseConfig(): boolean {
  return Boolean(env("SUPABASE_URL") && (env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY")));
}

function supabaseHeaders() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

type StaticLibraryIndex = {
  tasks?: Array<GuiAgentTask & { staticPath?: string }>;
};

function staticLibraryRoot(): string {
  return path.resolve(process.cwd(), "public", "trajectory-library");
}

function readStaticLibraryIndex(): StaticLibraryIndex | null {
  const indexPath = path.join(staticLibraryRoot(), "index.json");
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8")) as StaticLibraryIndex;
  } catch {
    return null;
  }
}

function staticPathForTask(task: GuiAgentTask): string | undefined {
  return (task as GuiAgentTask & { staticPath?: string }).staticPath;
}

function readStaticTask(task: GuiAgentTask): GuiAgentTask | null {
  const staticPath = staticPathForTask(task);
  if (!staticPath || !staticPath.startsWith("/trajectory-library/tasks/")) return null;
  const filePath = path.resolve(process.cwd(), "public", staticPath.replace(/^\//, ""));
  if (!filePath.startsWith(staticLibraryRoot()) || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as GuiAgentTask;
  } catch {
    return null;
  }
}

async function supabaseFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = env("SUPABASE_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...supabaseHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function upsertRows(path: string, rows: unknown[], batchSize: number): Promise<void> {
  for (const batch of chunks(rows, batchSize)) {
    if (batch.length === 0) continue;
    await supabaseFetch(path, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });
  }
}

export function localSearchTasks(query = ""): GuiAgentTask[] {
  const comparableOnly = (task: GuiAgentTask) => task.traces.length >= 2;
  const staticIndex = readStaticLibraryIndex();
  if (staticIndex?.tasks?.length) {
    const needle = query.trim().toLowerCase();
    const tasks = staticIndex.tasks.filter(comparableOnly);
    if (!needle) return tasks.slice(0, 100);
    return tasks
      .filter((task) => {
        const text = [
          task.taskId,
          task.title,
          task.domain,
          task.instruction,
          task.startUrl,
          task.riskTags.join(" "),
          task.benchmark ?? "",
          task.site ?? "",
          task.sourceCollection ?? "",
          ...task.traces.map((trace) => `${trace.traceId} ${trace.modelId} ${trace.sourceLabel ?? ""}`),
          ...task.traces.map(
            (trace) =>
              `${trace.benchmark ?? ""} ${trace.site ?? ""} ${trace.sourceCollection ?? ""} ${trace.actorType ?? ""} ${
                trace.outcome ?? ""
              }`,
          ),
        ]
          .join(" ")
          .toLowerCase();
        return text.includes(needle);
      })
      .slice(0, 100);
  }
  const needle = query.trim().toLowerCase();
  const tasks = guiAgentTasks.filter(comparableOnly);
  if (!needle) return tasks;
  return tasks.filter((task) => {
    const text = [
      task.taskId,
      task.title,
      task.domain,
      task.instruction,
      task.startUrl,
      task.riskTags.join(" "),
      task.benchmark ?? "",
      task.site ?? "",
      task.sourceCollection ?? "",
      ...task.traces.map((trace) => `${trace.traceId} ${trace.modelId} ${trace.sourceLabel ?? ""}`),
      ...task.traces.map((trace) => `${trace.benchmark ?? ""} ${trace.site ?? ""} ${trace.sourceCollection ?? ""} ${trace.actorType ?? ""} ${trace.outcome ?? ""}`),
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(needle);
  });
}

function rowToTask(row: SupabaseTaskRow, traces: GuiAgentTrace[] = []): GuiAgentTask {
  return {
    taskId: row.task_id,
    title: row.title,
    instruction: row.instruction,
    domain: row.domain,
    startUrl: row.start_url ?? "offline://trajectory",
    successCriteria: row.success_criteria ?? "Compare observable trajectory actions and states.",
    riskTags: row.risk_tags ?? ["database"],
    textState: row.text_state ?? "Observable trace states are available.",
    visualState: row.visual_state ?? "Screenshots or render references may be external.",
    screenshotSize: {
      width: row.screenshot_width ?? 1280,
      height: row.screenshot_height ?? 820,
    },
    traces,
    sourceType: row.source_type as GuiAgentTask["sourceType"],
    sourceLabel: row.source_label ?? undefined,
    benchmark: row.benchmark ?? undefined,
    taskNumericId: row.task_numeric_id ?? undefined,
    site: row.site ?? undefined,
    sourceCollection: row.source_collection ?? undefined,
    sourcePath: row.source_path ?? undefined,
  };
}

function rowsToTrace(run: SupabaseRunRow, steps: SupabaseStepRow[]): GuiAgentTrace {
  return {
    traceId: run.trace_id,
    agentId: run.agent_id,
    agentKind: run.agent_kind,
    modelId: run.model_id,
    taskId: run.task_id,
    sourceType: run.source_type,
    sourceLabel: run.source_label ?? undefined,
    sourceWarnings: run.source_warnings ?? undefined,
    steps: steps
      .filter((step) => step.trace_id === run.trace_id)
      .sort((a, b) => a.step_index - b.step_index)
      .map((step) => ({
        stepIndex: step.step_index,
        observationType: step.observation_type,
        observationSummary: step.observation_summary,
        actionType: step.action_type,
        target: {
          label: step.target_label,
          domSelector: step.dom_selector ?? undefined,
          bbox: step.bbox ?? [0, 0, 80, 32],
        },
        inputText: step.input_text ?? undefined,
        structuredRationale: step.structured_rationale ?? "Observable database trajectory action.",
        confidence: step.confidence ?? 0.5,
        stateAfter: step.state_after,
        url: step.url ?? undefined,
        screenshotRef: step.screenshot_ref ?? undefined,
        thumbnailRef: step.thumbnail_ref ?? undefined,
        sourceRef: step.source_ref ?? undefined,
        sourceHtmlPath: step.source_html_path ?? undefined,
        visualFrameAvailable: step.visual_frame_available ?? undefined,
        adapterConfidence: step.adapter_confidence ?? undefined,
        sourceWarnings: step.source_warnings ?? undefined,
      })),
    benchmark: run.benchmark ?? undefined,
    site: run.site ?? undefined,
    sourceCollection: run.source_collection ?? undefined,
    actorType: run.actor_type ?? undefined,
    promptSetting: run.prompt_setting ?? undefined,
    observationMode: run.observation_mode ?? undefined,
    outcome: run.outcome ?? undefined,
    sourcePath: run.source_path ?? undefined,
  };
}

export async function searchTasks(query = ""): Promise<GuiAgentTask[]> {
  if (!hasSupabaseConfig()) return localSearchTasks(query);
  const escaped = query.replace(/[%*,]/g, " ").trim();
  const filter = escaped
    ? `or=(title.ilike.*${encodeURIComponent(escaped)}*,instruction.ilike.*${encodeURIComponent(escaped)}*,domain.ilike.*${encodeURIComponent(escaped)}*,benchmark.ilike.*${encodeURIComponent(escaped)}*,site.ilike.*${encodeURIComponent(escaped)}*,source_collection.ilike.*${encodeURIComponent(escaped)}*)`
    : "select=*";
  const path = escaped ? `tasks?${filter}&limit=500` : "tasks?select=*&limit=500";
  const rows = await supabaseFetch<SupabaseTaskRow[]>(path);
  const taskIds = rows.map((row) => row.task_id);
  const runs =
    taskIds.length > 0
      ? await supabaseFetch<SupabaseRunRow[]>(`trajectory_runs?task_id=in.(${taskIds.map(encodeURIComponent).join(",")})`)
      : [];
  return rows
    .map((row) => rowToTask(row, runs.filter((run) => run.task_id === row.task_id).map((run) => rowsToTrace(run, []))))
    .filter((task) => task.traces.length >= 2)
    .slice(0, 100);
}

export async function getTaskWithRuns(taskId: string): Promise<GuiAgentTask | null> {
  const staticIndex = readStaticLibraryIndex();
  const staticTask = staticIndex?.tasks?.find((task) => task.taskId === taskId);
  if (staticTask && !hasSupabaseConfig()) return readStaticTask(staticTask) ?? staticTask;

  const local = guiAgentTasks.find((task) => task.taskId === taskId);
  if (!hasSupabaseConfig()) return local ?? null;

  const taskRows = await supabaseFetch<SupabaseTaskRow[]>(`tasks?task_id=eq.${encodeURIComponent(taskId)}&limit=1`);
  const taskRow = taskRows[0];
  if (!taskRow) return local ?? null;
  const runs = await supabaseFetch<SupabaseRunRow[]>(`trajectory_runs?task_id=eq.${encodeURIComponent(taskId)}`);
  const traceIds = runs.map((run) => run.trace_id);
  const steps =
    traceIds.length > 0
      ? await supabaseFetch<SupabaseStepRow[]>(`trajectory_steps?trace_id=in.(${traceIds.map(encodeURIComponent).join(",")})`)
      : [];
  return rowToTask(
    taskRow,
    runs.map((run) => rowsToTrace(run, steps)),
  );
}

export async function getTraceById(traceId: string): Promise<{ task: GuiAgentTask; trace: GuiAgentTrace } | null> {
  for (const task of guiAgentTasks) {
    const trace = task.traces.find((candidate) => candidate.traceId === traceId);
    if (trace) return { task, trace };
  }
  if (!hasSupabaseConfig()) return null;
  const runs = await supabaseFetch<SupabaseRunRow[]>(`trajectory_runs?trace_id=eq.${encodeURIComponent(traceId)}&limit=1`);
  const run = runs[0];
  if (!run) return null;
  const task = await getTaskWithRuns(run.task_id);
  const trace = task?.traces.find((candidate) => candidate.traceId === traceId);
  return task && trace ? { task, trace } : null;
}

export async function compareRunIds(runA: string, runB: string) {
  const a = await getTraceById(runA);
  const b = await getTraceById(runB);
  if (!a || !b || a.task.taskId !== b.task.taskId) {
    return null;
  }
  return {
    task: a.task,
    traceA: a.trace,
    traceB: b.trace,
    analysis: analyzeGuiAgentTraces(a.task, a.trace, b.trace),
  };
}

function taskToRow(task: GuiAgentTask): SupabaseTaskRow {
  return {
    task_id: task.taskId,
    title: task.title,
    instruction: task.instruction,
    domain: task.domain,
    start_url: task.startUrl,
    success_criteria: task.successCriteria,
    risk_tags: task.riskTags,
    text_state: task.textState,
    visual_state: task.visualState,
    screenshot_width: task.screenshotSize.width,
    screenshot_height: task.screenshotSize.height,
    source_type: task.sourceType ?? null,
    source_label: task.sourceLabel ?? null,
    benchmark: task.benchmark ?? null,
    task_numeric_id: task.taskNumericId ?? null,
    site: task.site ?? null,
    source_collection: task.sourceCollection ?? null,
    source_path: task.sourcePath ?? null,
  };
}

function traceToRow(trace: GuiAgentTrace): SupabaseRunRow {
  return {
    trace_id: trace.traceId,
    task_id: trace.taskId,
    agent_id: trace.agentId,
    agent_kind: trace.agentKind,
    model_id: trace.modelId,
    source_type: trace.sourceType,
    source_label: trace.sourceLabel ?? null,
    source_warnings: trace.sourceWarnings ?? null,
    benchmark: trace.benchmark ?? null,
    site: trace.site ?? null,
    source_collection: trace.sourceCollection ?? null,
    actor_type: trace.actorType ?? null,
    prompt_setting: trace.promptSetting ?? null,
    observation_mode: trace.observationMode ?? null,
    outcome: trace.outcome ?? null,
    source_path: trace.sourcePath ?? null,
  };
}

function stepToRow(trace: GuiAgentTrace, step: GuiAgentTrace["steps"][number]): SupabaseStepRow {
  return {
    trace_id: trace.traceId,
    step_index: step.stepIndex,
    observation_type: step.observationType,
    observation_summary: step.observationSummary,
    action_type: step.actionType,
    target_label: step.target.label,
    dom_selector: step.target.domSelector ?? null,
    bbox: step.target.bbox,
    input_text: step.inputText ?? null,
    structured_rationale: step.structuredRationale,
    confidence: step.confidence,
    state_after: step.stateAfter,
    url: step.url ?? null,
    screenshot_ref: step.screenshotRef ?? null,
    thumbnail_ref: step.thumbnailRef ?? null,
    source_ref: step.sourceRef ?? null,
    source_html_path: step.sourceHtmlPath ?? null,
    visual_frame_available: step.visualFrameAvailable ?? Boolean(step.thumbnailRef ?? step.screenshotRef),
    adapter_confidence: step.adapterConfidence ?? null,
    source_warnings: step.sourceWarnings ?? null,
  };
}

export async function upsertTasks(tasks: GuiAgentTask[]) {
  const taskCount = tasks.length;
  const runCount = tasks.reduce((sum, task) => sum + task.traces.length, 0);
  const stepCount = tasks.reduce((sum, task) => sum + task.traces.reduce((stepSum, trace) => stepSum + trace.steps.length, 0), 0);
  if (!hasSupabaseConfig()) {
    return { persisted: false, taskCount, runCount, stepCount };
  }
  const taskRows = tasks.map(taskToRow);
  const runRows = tasks.flatMap((task) => task.traces.map(traceToRow));
  const stepRows = tasks.flatMap((task) => task.traces.flatMap((trace) => trace.steps.map((step) => stepToRow(trace, step))));
  await upsertRows("tasks?on_conflict=task_id", taskRows, 500);
  await upsertRows("trajectory_runs?on_conflict=trace_id", runRows, 500);
  await upsertRows("trajectory_steps?on_conflict=trace_id,step_index", stepRows, 1000);
  return { persisted: true, taskCount: taskRows.length, runCount: runRows.length, stepCount: stepRows.length };
}

export function setJsonHeaders(res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");
  res.setHeader?.("Access-Control-Allow-Origin", "*");
  res.setHeader?.("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader?.("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader?.("Access-Control-Max-Age", "86400");
}

export function handleCorsPreflight(req: ApiRequest, res: ApiResponse): boolean {
  setJsonHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(200).json({ ok: true });
    return true;
  }
  return false;
}

export function methodNotAllowed(res: ApiResponse, method: string) {
  res.status(405).json({ ok: false, errors: [`Use ${method}`] });
}
