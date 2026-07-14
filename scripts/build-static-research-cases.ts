import fs from "node:fs/promises";
import path from "node:path";
import { analyzeGuiAgentTraces } from "../src/projectLogic.js";
import type { GuiAgentTask, GuiAgentTrace, GuiTraceStepComparison } from "../src/projectTypes.js";

type ResearchCaseKind =
  | "high_overlap"
  | "strong_rejoin"
  | "persistent_divergence"
  | "human_vs_model"
  | "model_vs_model"
  | "early_split"
  | "long_recovery"
  | "low_missing_divergence";

type ResearchCase = {
  kind: ResearchCaseKind;
  label: string;
  interpretation: {
    en: string;
    zh: string;
  };
  taskId: string;
  staticPath: string;
  title: string;
  benchmark?: string;
  site?: string;
  runAId: string;
  runBId: string;
  runALabel: string;
  runBLabel: string;
  pairKind: string;
  metrics: {
    missingRate: number;
    overlapRate: number;
    maxDivergence: number;
    meanDivergence: number;
    rejoinStep: number | null;
    persistent: boolean;
    visualFrameRate: number;
    stepPairs: number;
  };
};

const caseSpecs: Array<{ kind: ResearchCaseKind; label: string; take: number; score: (row: ResearchCase) => number }> = [
  {
    kind: "high_overlap",
    label: "High overlap",
    take: 3,
    score: (row) => row.metrics.overlapRate - row.metrics.maxDivergence * 0.2 + Math.min(row.metrics.stepPairs, 14) / 100,
  },
  {
    kind: "strong_rejoin",
    label: "Clear rejoin",
    take: 3,
    score: (row) => (row.metrics.rejoinStep === null ? -1 : row.metrics.maxDivergence + row.metrics.overlapRate * 0.25),
  },
  {
    kind: "persistent_divergence",
    label: "Persistent split",
    take: 3,
    score: (row) => (row.metrics.persistent && row.metrics.missingRate <= 0.22 ? row.metrics.maxDivergence + row.metrics.meanDivergence * 0.35 : -1),
  },
  { kind: "human_vs_model", label: "Human vs model", take: 3, score: (row) => (row.pairKind === "human_vs_model" ? row.metrics.maxDivergence : -1) },
  { kind: "model_vs_model", label: "Model vs model", take: 3, score: (row) => (row.pairKind === "model_vs_model" ? row.metrics.maxDivergence : -1) },
  { kind: "early_split", label: "Early split", take: 2, score: (row) => row.metrics.maxDivergence + row.metrics.meanDivergence * 0.2 },
  {
    kind: "long_recovery",
    label: "Long recovery",
    take: 2,
    score: (row) => (row.metrics.rejoinStep === null ? -1 : row.metrics.rejoinStep / Math.max(1, row.metrics.stepPairs)),
  },
  {
    kind: "low_missing_divergence",
    label: "Clean divergence",
    take: 1,
    score: (row) => (row.metrics.missingRate <= 0.08 ? row.metrics.maxDivergence + row.metrics.meanDivergence : -1),
  },
];

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function labelTrace(trace: GuiAgentTrace): string {
  return [trace.modelId, trace.actorType ?? trace.agentKind, trace.observationMode, trace.outcome].filter(Boolean).join(" / ");
}

function pairKind(runA: GuiAgentTrace, runB: GuiAgentTrace): string {
  const aHuman = runA.actorType === "human" || runA.agentKind === "human";
  const bHuman = runB.actorType === "human" || runB.agentKind === "human";
  if (aHuman !== bHuman) return "human_vs_model";
  if (aHuman && bHuman) return "human_vs_human";
  return "model_vs_model";
}

function isExplicitFailureRun(trace: GuiAgentTrace): boolean {
  return trace.outcome === "failed" || /\bfailed\b/i.test(labelTrace(trace));
}

function isExplicitFailureCase(row: ResearchCase): boolean {
  return /\bfailed|failure|early stop|unable to|could not|cannot|not found|same action\b/i.test(`${row.runALabel} ${row.runBLabel}`);
}

function isFailureLikeStepText(trace: GuiAgentTrace): boolean {
  const terminal = trace.steps.slice(-3);
  return terminal.some((step) =>
    /\b(failed|failure|early stop|unable to|could not|cannot|not found|same action|task failed)\b/i.test(
      [step.actionType, step.target?.label, step.observationSummary, step.stateAfter, step.structuredRationale, step.agentOutputExcerpt].filter(Boolean).join(" "),
    ),
  );
}

function isQualityCandidate(row: ResearchCase): boolean {
  if (isExplicitFailureCase(row)) return false;
  if (row.metrics.stepPairs < 4) return false;
  if (row.metrics.missingRate > 0.3) return false;
  if (row.metrics.visualFrameRate < 0.6 && row.pairKind === "human_vs_model") return false;
  return true;
}

function hasFrame(step: GuiTraceStepComparison): boolean {
  return Boolean(
    step.textStep?.thumbnailRef ||
      step.textStep?.screenshotRef ||
      step.textStep?.visualFrameAvailable ||
      step.visionStep?.thumbnailRef ||
      step.visionStep?.screenshotRef ||
      step.visionStep?.visualFrameAvailable,
  );
}

function buildCase(task: GuiAgentTask, staticPath: string, runA: GuiAgentTrace, runB: GuiAgentTrace): ResearchCase {
  const analysis = analyzeGuiAgentTraces(task, runA, runB);
  const comparisons = analysis.comparisons;
  const stepPairs = comparisons.length;
  const missing = comparisons.filter((row) => !row.textStep || !row.visionStep).length;
  const overlap = comparisons.filter(
    (row) => row.textStep && row.visionStep && (row.event === "stable" || row.event === "rejoined" || row.divergenceScore <= 0.18),
  ).length;
  const visual = comparisons.filter(hasFrame).length;
  const maxDivergence = Math.max(0, ...comparisons.map((row) => row.divergenceScore));
  const meanDivergence = comparisons.reduce((sum, row) => sum + row.divergenceScore, 0) / Math.max(1, stepPairs);
  return {
    kind: "low_missing_divergence",
    label: "Candidate",
    interpretation: {
      en: "Candidate case before category-specific interpretation is assigned.",
      zh: "分配具体类别解释前的候选案例。",
    },
    taskId: task.taskId,
    staticPath,
    title: task.instruction || task.title,
    benchmark: task.benchmark,
    site: task.site,
    runAId: runA.traceId,
    runBId: runB.traceId,
    runALabel: labelTrace(runA),
    runBLabel: labelTrace(runB),
    pairKind: pairKind(runA, runB),
    metrics: {
      missingRate: round(missing / Math.max(1, stepPairs)),
      overlapRate: round(overlap / Math.max(1, stepPairs)),
      maxDivergence: round(maxDivergence),
      meanDivergence: round(meanDivergence),
      rejoinStep: analysis.rejoinStep,
      persistent: analysis.persistentDivergence,
      visualFrameRate: round(visual / Math.max(1, stepPairs)),
      stepPairs,
    },
  };
}

function caseInterpretation(row: ResearchCase, kind: ResearchCaseKind): ResearchCase["interpretation"] {
  const overlap = Math.round(row.metrics.overlapRate * 100);
  const missing = Math.round(row.metrics.missingRate * 100);
  const divergence = Math.round(row.metrics.maxDivergence * 100);
  const rejoin = row.metrics.rejoinStep;
  if (kind === "high_overlap") {
    return {
      en: `${overlap}% overlap means most aligned steps stay near the same GUI state/action path; useful as a sanity check for over-splitting.`,
      zh: `${overlap}% 重叠表示大多数对齐步骤仍接近同一 GUI 状态/动作路径，适合检查系统是否过度分叉。`,
    };
  }
  if (kind === "strong_rejoin") {
    return {
      en: `Rejoin at step ${rejoin ?? "-"} suggests the runs diverge temporarily and later return to comparable state; useful for rejoin detection.`,
      zh: `第 ${rejoin ?? "-"} 步回归表示两条轨迹短暂分叉后又回到可比状态，适合检查回归识别。`,
    };
  }
  if (kind === "persistent_divergence") {
    return {
      en: `${divergence}% max divergence with persistent split suggests the paths remain separated after the first major fork.`,
      zh: `${divergence}% 最大偏移且持续分叉，表示首次明显分叉后两条路径长期保持分离。`,
    };
  }
  if (kind === "human_vs_model") {
    return {
      en: `${divergence}% divergence in a human-vs-model pair highlights where model behavior departs from a human reference workflow.`,
      zh: `人类-模型对比中 ${divergence}% 偏移，可观察模型行为从人类参考流程偏离的位置。`,
    };
  }
  if (kind === "model_vs_model") {
    return {
      en: `${divergence}% divergence between model runs isolates differences from prompt/model settings without using a human reference.`,
      zh: `模型-模型之间 ${divergence}% 偏移，用于观察不同模型或提示设置造成的轨迹差异。`,
    };
  }
  if (kind === "early_split") {
    return {
      en: `${divergence}% max divergence with low missing suggests an early actionable split rather than a metadata artifact.`,
      zh: `${divergence}% 最大偏移且缺失率较低，通常说明早期动作/状态分叉，而非元数据缺失造成。`,
    };
  }
  if (kind === "long_recovery") {
    return {
      en: `Rejoin at step ${rejoin ?? "-"} after several steps is useful for studying recovery after a non-trivial detour.`,
      zh: `多步之后在第 ${rejoin ?? "-"} 步回归，适合研究绕路后的恢复过程。`,
    };
  }
  return {
    en: `${missing}% missing with ${divergence}% max divergence suggests the difference is mostly observable disagreement, not absent counterparts.`,
    zh: `${missing}% 缺失且最大偏移 ${divergence}%，说明差异主要来自可观察动作/状态不一致，而不是缺少对应步。`,
  };
}

function labelForKind(kind: ResearchCaseKind): string {
  if (kind === "high_overlap") return "High overlap";
  if (kind === "strong_rejoin") return "Clear rejoin";
  if (kind === "persistent_divergence") return "Persistent split";
  if (kind === "human_vs_model") return "Human vs model";
  if (kind === "model_vs_model") return "Model vs model";
  if (kind === "early_split") return "Early split";
  if (kind === "long_recovery") return "Long recovery";
  return "Clean divergence";
}

function supplementalKind(row: ResearchCase): ResearchCaseKind {
  if (row.metrics.rejoinStep !== null && row.metrics.rejoinStep >= Math.max(3, row.metrics.stepPairs * 0.35)) return "long_recovery";
  if (row.metrics.rejoinStep !== null) return "strong_rejoin";
  if (row.metrics.persistent) return "persistent_divergence";
  if (row.pairKind === "human_vs_model") return "human_vs_model";
  if (row.pairKind === "model_vs_model") return "model_vs_model";
  if (row.metrics.overlapRate >= 0.5) return "high_overlap";
  if (row.metrics.meanDivergence >= 0.35) return "early_split";
  return "low_missing_divergence";
}

function supplementalScore(row: ResearchCase): number {
  const pairBonus = row.pairKind === "human_vs_model" || row.pairKind === "model_vs_model" ? 0.12 : 0;
  const rejoinBonus = row.metrics.rejoinStep === null ? 0 : 0.16;
  const missingPenalty = row.metrics.missingRate * 0.9;
  return row.metrics.maxDivergence + row.metrics.meanDivergence * 0.45 + row.metrics.overlapRate * 0.12 + pairBonus + rejoinBonus - missingPenalty;
}

function caseKey(row: ResearchCase): string {
  return `${row.taskId}__${row.runAId}__${row.runBId}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function main() {
  const libraryDir = path.resolve(argValue("--library", "public/trajectory-library"));
  const outPath = path.resolve(argValue("--out", path.join(libraryDir, "research-cases.json")));
  const maxTasks = Number(argValue("--max-tasks", "1200")) || 1200;
  const index = await readJson<{ tasks?: Array<{ taskId: string; staticPath?: string }> }>(path.join(libraryDir, "index.json"));
  const rows: ResearchCase[] = [];
  let scannedTasks = 0;

  for (const indexTask of index.tasks ?? []) {
    if (!indexTask.staticPath) continue;
    const taskPath = path.join(libraryDir, indexTask.staticPath.replace(/^\/?trajectory-library[\\/]/, ""));
    const task = await readJson<GuiAgentTask>(taskPath);
    if ((task.traces?.length ?? 0) < 2) continue;
    scannedTasks += 1;
    for (let left = 0; left < task.traces.length; left += 1) {
      for (let right = left + 1; right < task.traces.length; right += 1) {
        const runA = task.traces[left];
        const runB = task.traces[right];
        if (!runA || !runB || runA.steps.length === 0 || runB.steps.length === 0) continue;
        if (isExplicitFailureRun(runA) || isExplicitFailureRun(runB)) continue;
        if (isFailureLikeStepText(runA) || isFailureLikeStepText(runB)) continue;
        rows.push(buildCase(task, indexTask.staticPath, runA, runB));
      }
    }
    if (scannedTasks >= maxTasks) break;
  }

  const selected: ResearchCase[] = [];
  const usedPairs = new Set<string>();
  const usedTasks = new Set<string>();
  for (const spec of caseSpecs) {
    const candidates = rows
      .map((row) => ({ row, score: spec.score(row) }))
      .filter(({ row, score }) => score >= 0 && Number.isFinite(score) && isQualityCandidate(row))
      .sort((a, b) => b.score - a.score || b.row.metrics.stepPairs - a.row.metrics.stepPairs);
    for (const candidate of candidates.slice(0, 24)) {
      const key = caseKey(candidate.row);
      if (usedPairs.has(key)) continue;
      if (usedTasks.has(candidate.row.taskId)) continue;
      usedPairs.add(key);
      usedTasks.add(candidate.row.taskId);
      selected.push({ ...candidate.row, kind: spec.kind, label: spec.label, interpretation: caseInterpretation(candidate.row, spec.kind) });
      if (selected.filter((row) => row.kind === spec.kind).length >= spec.take) break;
    }
  }

  const supplemental = rows
    .filter((row) => isQualityCandidate(row) && !usedPairs.has(caseKey(row)) && !usedTasks.has(row.taskId))
    .sort((a, b) => supplementalScore(b) - supplementalScore(a) || b.metrics.stepPairs - a.metrics.stepPairs);
  for (const row of supplemental) {
    const kind = supplementalKind(row);
    selected.push({ ...row, kind, label: labelForKind(kind), interpretation: caseInterpretation(row, kind) });
    usedPairs.add(caseKey(row));
    usedTasks.add(row.taskId);
    if (selected.length >= 20) break;
  }

  if (selected.length < 20) {
    const pairFallback = rows
      .filter((row) => isQualityCandidate(row) && !usedPairs.has(caseKey(row)))
      .sort((a, b) => supplementalScore(b) - supplementalScore(a) || b.metrics.stepPairs - a.metrics.stepPairs);
    for (const row of pairFallback) {
      const kind = supplementalKind(row);
      selected.push({ ...row, kind, label: labelForKind(kind), interpretation: caseInterpretation(row, kind) });
      usedPairs.add(caseKey(row));
      if (selected.length >= 20) break;
    }
  }

  await fs.writeFile(
    outPath,
    `${JSON.stringify(
      {
        schemaVersion: "tracefork-research-cases-v1",
        generatedAt: new Date().toISOString(),
        boundary: [
          "Cases are selected from normalized real offline trajectory files.",
      "Metrics describe inspection patterns, not task-success causality.",
          "Research cases avoid page-frame-coverage-only categories; screenshots may still support inspection but are not the case metric.",
          "Clicking a case lazy-loads the full same-task run pair.",
        ],
        totalPairsScored: rows.length,
        scannedComparableTasks: scannedTasks,
        cases: selected.slice(0, 20),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${selected.length} research cases from ${rows.length} pair(s) to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
