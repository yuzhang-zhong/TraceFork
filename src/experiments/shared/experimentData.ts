import { guiAgentTasks } from "../../projectData.js";
import { analyzeGuiAgentTraces } from "../../projectLogic.js";
import type { GuiAgentTask, GuiAgentTrace, GuiAgentTraceStep, GuiTraceAnalysis, GuiTraceStepComparison } from "../../projectTypes.js";

export type ExperimentCondition = "raw_logs" | "tracefork";

export type ExperimentPair = {
  pairId: string;
  task: GuiAgentTask;
  runA: GuiAgentTrace;
  runB: GuiAgentTrace;
  analysis: GuiTraceAnalysis;
};

export type GoldItem = {
  itemId: string;
  pair: ExperimentPair;
  comparison: GuiTraceStepComparison;
  itemKind: "aligned_step" | "stable" | "first_fork" | "high_divergence" | "rejoin" | "persistent";
};

export type GoldAnnotationRecord = {
  schemaVersion: "tracefork-human-gold-v1";
  annotatorId: string;
  itemId: string;
  pairId: string;
  taskId: string;
  runAId: string;
  runBId: string;
  aStepIndex: number | null;
  bStepIndex: number | null;
  label: "overlap" | "diverged" | "missing_a" | "missing_b" | "rejoined" | "unsure";
  severity: 0 | 1 | 2 | 3;
  laterOutcome: "rejoined" | "persistent" | "unsure";
  firstForkStepA: number | null;
  firstForkStepB: number | null;
  rejoinStepA: number | null;
  rejoinStepB: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type PilotTrial = {
  trialId: string;
  pair: ExperimentPair;
  recommendedCondition: ExperimentCondition;
};

export type PilotTrialRecord = {
  schemaVersion: "tracefork-analyst-pilot-v1";
  participantId: string;
  trialId: string;
  pairId: string;
  taskId: string;
  runAId: string;
  runBId: string;
  condition: ExperimentCondition;
  startedAt: string;
  submittedAt: string;
  elapsedMs: number;
  firstForkStepA: number | null;
  firstForkStepB: number | null;
  rejoinJudgment: "yes" | "no" | "unsure";
  mainCause: "action" | "target" | "state" | "visual" | "missing_metadata" | "unsure";
  confidence: number;
  usefulness: number;
  mentalEffort: number;
  feedback: string;
};

export type StaticLibraryIndex = {
  schemaVersion?: string;
  tasks?: Array<GuiAgentTask & { staticPath?: string }>;
};

const appBaseUrl = import.meta.env.BASE_URL || "/";

function appUrl(path: string): string {
  const base = appBaseUrl.endsWith("/") ? appBaseUrl : `${appBaseUrl}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

function isComparableTask(task: GuiAgentTask): boolean {
  return task.traces.length >= 2;
}

function pairId(task: GuiAgentTask, runA: GuiAgentTrace, runB: GuiAgentTrace): string {
  return `${task.taskId}__${runA.traceId}__${runB.traceId}`;
}

function staticPathForTask(task: GuiAgentTask & { staticPath?: string }): string | undefined {
  if (task.staticPath) return task.staticPath;
  const id = task.taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `trajectory-library/tasks/${id}.json`;
}

async function hydrateTask(task: GuiAgentTask & { staticPath?: string }): Promise<GuiAgentTask> {
  if (task.traces.length >= 2 && task.traces.every((trace) => trace.steps.length > 0)) return task;
  try {
    const response = await fetch(appUrl(staticPathForTask(task) ?? ""));
    if (response.ok) return (await response.json()) as GuiAgentTask;
  } catch {
    // Fall back below.
  }
  return task;
}

export async function loadExperimentPairs(limit = 24): Promise<ExperimentPair[]> {
  let tasks: GuiAgentTask[] = guiAgentTasks.filter(isComparableTask);
  try {
    const response = await fetch(appUrl("trajectory-library/index.json"));
    if (response.ok) {
      const index = (await response.json()) as StaticLibraryIndex;
      const indexedTasks = (index.tasks ?? []).filter(isComparableTask);
      if (indexedTasks.length) {
        tasks = await Promise.all(indexedTasks.slice(0, Math.max(limit * 2, 30)).map(hydrateTask));
      }
    }
  } catch {
    // Built-in examples are sufficient for local form testing.
  }

  const pairs: ExperimentPair[] = [];
  for (const task of tasks) {
    const runnableTraces = task.traces.filter((trace) => trace.steps.length > 0);
    if (runnableTraces.length < 2) continue;
    const runA = runnableTraces.find((trace) => trace.actorType === "model") ?? runnableTraces[0];
    const runB =
      runnableTraces.find((trace) => trace.traceId !== runA.traceId && trace.actorType === "human") ??
      runnableTraces.find((trace) => trace.traceId !== runA.traceId) ??
      runnableTraces[1];
    if (!runA || !runB || runA.traceId === runB.traceId) continue;
    pairs.push({
      pairId: pairId(task, runA, runB),
      task,
      runA,
      runB,
      analysis: analyzeGuiAgentTraces(task, runA, runB),
    });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

function goldItemKind(comparison: GuiTraceStepComparison): GoldItem["itemKind"] {
  if (comparison.event === "rejoined") return "rejoin";
  if (comparison.event === "persistent_divergence") return "persistent";
  if (comparison.event === "stable") return "stable";
  if (comparison.divergenceScore >= 0.55 || comparison.event === "diverged") return "high_divergence";
  return "aligned_step";
}

export function buildGoldItems(pairs: ExperimentPair[], itemLimit = 240): GoldItem[] {
  const items: GoldItem[] = [];
  for (const pair of pairs) {
    const firstForkIndex = pair.analysis.comparisons.findIndex(
      (comparison) => comparison.event === "diverged" || comparison.event === "persistent_divergence",
    );
    for (const [comparisonIndex, comparison] of pair.analysis.comparisons.entries()) {
      items.push({
        itemId: `${pair.pairId}__aligned__${comparison.stepIndex}`,
        pair,
        comparison,
        itemKind: comparisonIndex === firstForkIndex ? "first_fork" : goldItemKind(comparison),
      });
      if (items.length >= itemLimit) return items;
    }
  }
  return items;
}

export function buildPilotTrials(pairs: ExperimentPair[], limit = 24): PilotTrial[] {
  return pairs.slice(0, limit).map((pair, index) => ({
    trialId: `${pair.pairId}__trial_${index + 1}`,
    pair,
    recommendedCondition: index % 2 === 0 ? "tracefork" : "raw_logs",
  }));
}

export function getStepContext(trace: GuiAgentTrace, step: GuiAgentTraceStep | null): GuiAgentTraceStep[] {
  if (!step) return [];
  return trace.steps.filter((candidate) => Math.abs(candidate.stepIndex - step.stepIndex) <= 1);
}

export function displayableFrame(step: GuiAgentTraceStep | null | undefined): string | undefined {
  const ref = step?.thumbnailRef ?? step?.screenshotRef;
  if (!ref) return undefined;
  if (/^(data:|blob:|https?:)/i.test(ref)) return ref;
  if (/^(embedded:|zip:)/i.test(ref)) return undefined;
  return appUrl(ref);
}

export function cleanArtifactText(value: string | undefined): string {
  const raw = (value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const internalRoleName = raw.match(/^internal:role=.*?\bname=["']([^"']+)["']/i);
  if (internalRoleName?.[1]) return internalRoleName[1].trim();
  const parts = raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(page|url|action|target|obs|parsed|bbox|where):/i.test(part))
    .filter((part) => !/^\[?local url removed\]?$/i.test(part))
    .filter((part) => !/^page:\[[^\]]+\]$/i.test(part))
    .filter((part) => !/^page:\[?local url removed\]?$/i.test(part));
  const cleaned = parts.length ? parts.join(" | ") : raw;
  if (/^(page:\[[^\]]+\]\|?action:|page:\[?local url removed\]?\|?action:|action:|target:element-|obs:[a-z0-9_-]+|parsed:)/i.test(cleaned)) return "";
  if (/^(page|url|action|target|obs|parsed|bbox|where):/i.test(cleaned)) return "";
  return cleaned
    .replace(/page:\[[^\]]+\]/gi, "")
    .replace(/page:\[?local url removed\]?/gi, "")
    .replace(/\binternal:role=.*$/gi, "")
    .replace(/\b(action|target|obs|parsed|bbox|where):[^|\s/]+/gi, "")
    .replace(/\|+/g, " ")
    .replace(/\/+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortText(value: string | undefined, max = 120): string {
  const text = cleanArtifactText(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

export function traceLabel(trace: GuiAgentTrace): string {
  return [trace.modelId, trace.actorType, trace.observationMode, trace.outcome].filter(Boolean).join(" / ");
}

export function saveRecords<T>(key: string, records: T[]): void {
  const previous = localStorage.getItem(key);
  if (previous) {
    localStorage.setItem(`${key}:backup`, previous);
    localStorage.setItem(`${key}:backupAt`, new Date().toISOString());
  }
  localStorage.setItem(key, JSON.stringify(records, null, 2));
}

export function loadRecords<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function clearLegacyRecords(keys: string[]): void {
  for (const key of keys) {
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:backup`);
    localStorage.removeItem(`${key}:backupAt`);
  }
}

export function recordsToCsv(records: Array<Record<string, unknown>>): string {
  const columns = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...records.map((record) => columns.map((column) => escape(record[column])).join(","))].join("\n");
}

export function downloadText(filename: string, text: string, type = "application/json"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
