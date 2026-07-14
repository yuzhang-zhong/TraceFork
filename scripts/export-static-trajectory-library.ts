import fs from "node:fs/promises";
import path from "node:path";
import type { GuiAgentTask, GuiAgentTrace, GuiAgentTraceStep } from "../src/projectTypes";
import { importDatasetTrajectories } from "./dataset-trajectories";
import { buildDiagnosticRows } from "../src/traceDiagnostics";

type StaticTaskIndexRow = Omit<GuiAgentTask, "traces"> & {
  traces: Array<Omit<GuiAgentTrace, "steps"> & { steps: []; stepCount: number }>;
  staticPath: string;
};

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function compactText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? "")
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?/gi, "[local origin]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[web page]")
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/gi, "[local host]")
    .replace(/(^|[\s"'(])[a-z]:[\\/][^\s"'<>]+/gi, "$1[local path removed]")
    .replace(/\b(?:file):[^\s"'<>]+/gi, "[source ref]")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function safeFileId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "task"
  );
}

function compactStep(step: GuiAgentTraceStep): GuiAgentTraceStep {
  return {
    ...step,
    observationSummary: compactText(step.observationSummary, 420),
    structuredRationale: compactText(step.structuredRationale, 180),
    agentOutputExcerpt: step.agentOutputExcerpt ? compactText(step.agentOutputExcerpt, 320) : undefined,
    stateAfter: compactText(step.stateAfter, 420),
    url: step.url ? compactText(step.url, 260) : undefined,
    target: {
      ...step.target,
      label: compactText(step.target.label, 160),
      domSelector: step.target.domSelector ? compactText(step.target.domSelector, 160) : undefined,
    },
    inputText: step.inputText ? compactText(step.inputText, 160) : undefined,
  };
}

function compactTrace(trace: GuiAgentTrace): GuiAgentTrace {
  return {
    ...trace,
    steps: trace.steps.map(compactStep),
  };
}

function indexTrace(trace: GuiAgentTrace): StaticTaskIndexRow["traces"][number] {
  const { steps: _steps, ...rest } = trace;
  return {
    ...rest,
    steps: [],
    stepCount: trace.steps.length,
  };
}

function compactTask(task: GuiAgentTask): GuiAgentTask {
  return {
    ...task,
    title: compactText(task.title, 180),
    instruction: compactText(task.instruction, 420),
    startUrl: compactText(task.startUrl, 260),
    successCriteria: compactText(task.successCriteria, 220),
    textState: compactText(task.textState, 520),
    visualState: compactText(task.visualState, 220),
    traces: task.traces.map(compactTrace),
  };
}

function indexTask(task: GuiAgentTask, staticPath: string): StaticTaskIndexRow {
  const { traces: _traces, ...rest } = task;
  return {
    ...rest,
    title: compactText(task.title, 180),
    instruction: compactText(task.instruction, 300),
    startUrl: compactText(task.startUrl, 220),
    successCriteria: compactText(task.successCriteria, 180),
    textState: compactText(task.textState, 220),
    visualState: compactText(task.visualState, 180),
    traces: task.traces.map(indexTrace),
    staticPath,
  };
}

async function writeJson(targetPath: string, value: unknown): Promise<number> {
  const body = `${JSON.stringify(value)}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body, "utf8");
  return Buffer.byteLength(body);
}

async function main() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const rootDir = path.resolve(argValue("--root", positional) ?? "Datasets");
  const outDir = path.resolve(argValue("--out", "public/trajectory-library") ?? "public/trajectory-library");
  const maxTasksPerCollection = hasFlag("--full") ? undefined : Number(argValue("--max-tasks-per-collection", "2")) || 2;
  const collectionFilter = argValue("--collection");
  const progress = hasFlag("--progress") && !hasFlag("--quiet");
  const writeThumbnails = hasFlag("--write-thumbnails");
  const thumbnailLimit = Number(argValue("--thumbnail-limit", "80")) || 80;

  await fs.rm(outDir, { recursive: true, force: true });
  if (writeThumbnails && hasFlag("--reset-thumbnails")) {
    await fs.rm(path.resolve("public", "trajectory-thumbnails"), { recursive: true, force: true });
  }
  const { tasks, audit } = await importDatasetTrajectories({
    rootDir,
    maxTasksPerCollection,
    collectionFilter,
    progress,
    writeThumbnails,
    thumbnailLimitPerRun: thumbnailLimit,
  });

  const taskDir = path.join(outDir, "tasks");
  const usedFileIds = new Map<string, number>();
  const indexRows: StaticTaskIndexRow[] = [];
  let taskBytes = 0;

  for (const task of tasks) {
    const baseId = safeFileId(task.taskId);
    const count = usedFileIds.get(baseId) ?? 0;
    usedFileIds.set(baseId, count + 1);
    const fileId = count === 0 ? baseId : `${baseId}-${count + 1}`;
    const staticPath = `/trajectory-library/tasks/${fileId}.json`;
    const compact = compactTask(task);
    taskBytes += await writeJson(path.join(taskDir, `${fileId}.json`), compact);
    indexRows.push(indexTask(task, staticPath));
  }

  const index = {
    schemaVersion: "tracefork-static-trajectory-library-v1",
    generatedAt: new Date().toISOString(),
    sourceRoot: "local dataset root excluded from public build",
    mode: maxTasksPerCollection ? `bounded:${maxTasksPerCollection}-task(s)-per-collection` : "full",
    boundary: [
      "Static library contains compact normalized offline WebArena/VisualWebArena trajectories.",
      "It excludes raw archives and does not analyze private reasoning or chain-of-thought.",
      "Task files are lazy-loaded by the frontend for same-task run comparison.",
    ],
    totals: {
      collectionCount: audit.collectionCount,
      taskCount: tasks.length,
      comparableTaskCount: tasks.filter((task) => task.traces.length >= 2).length,
      runCount: audit.runCount,
      stepCount: audit.stepCount,
      taskJsonBytes: taskBytes,
    },
    collections: audit.collections,
    tasks: indexRows,
  };
  const indexBytes = await writeJson(path.join(outDir, "index.json"), index);
  const diagnostics = {
    schemaVersion: "tracefork-agentdiagnose-static-index-v1",
    generatedAt: index.generatedAt,
    method: [
      "Inspired by AgentDiagnose: trajectory retrieval is indexed by diagnostic dimensions rather than only keyword matching.",
      "Scores are deterministic heuristics over observable actions, states, observations, metadata, and screenshot availability.",
      "The index does not expose or evaluate private chain-of-thought.",
    ],
    dimensions: [
      "backtracking_exploration",
      "task_decomposition",
      "observation_reading",
      "self_verification",
      "objective_quality",
      "state_transition",
      "visual_evidence",
    ],
    rows: buildDiagnosticRows(tasks.map((task, index) => ({ ...task, staticPath: indexRows[index]?.staticPath }))),
  };
  const diagnosticsBytes = await writeJson(path.join(outDir, "diagnostics.json"), diagnostics);
  await writeJson(path.join(outDir, "manifest.json"), {
    schemaVersion: "tracefork-static-trajectory-library-manifest-v1",
    generatedAt: index.generatedAt,
    totals: index.totals,
    indexPath: "/trajectory-library/index.json",
    diagnosticsPath: "/trajectory-library/diagnostics.json",
    boundary: index.boundary,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        mode: index.mode,
        taskCount: tasks.length,
        comparableTaskCount: index.totals.comparableTaskCount,
        runCount: audit.runCount,
        stepCount: audit.stepCount,
        indexBytes,
        diagnosticsBytes,
        taskBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
