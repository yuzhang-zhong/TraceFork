import type { GuiAgentTask, GuiAgentTrace, GuiAgentTraceStep } from "./projectTypes.js";

export type AgentDiagnoseDimension =
  | "backtracking_exploration"
  | "task_decomposition"
  | "observation_reading"
  | "self_verification"
  | "objective_quality"
  | "state_transition"
  | "visual_evidence";

export type TraceDiagnosticScores = Record<AgentDiagnoseDimension, number>;

export type DiagnosticTaskRow = {
  taskId: string;
  title: string;
  instruction: string;
  benchmark?: string;
  site?: string;
  sourceCollection?: string;
  staticPath?: string;
  scores: TraceDiagnosticScores;
  tags: string[];
  actionTerms: string[];
  stateTerms: string[];
  runCount: number;
  stepCount: number;
};

export type DiagnosticSearchOptions = {
  dimension: AgentDiagnoseDimension;
  minScore: number;
  pattern?: string;
  taskQuery?: string;
};

const dimensionOrder: AgentDiagnoseDimension[] = [
  "backtracking_exploration",
  "task_decomposition",
  "observation_reading",
  "self_verification",
  "objective_quality",
  "state_transition",
  "visual_evidence",
];

function clampScore(value: number): number {
  return Math.max(1, Math.min(4, Number.isFinite(value) ? value : 1));
}

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/[^\s"'<>]+/g, " ")
    .replace(/[^a-z0-9_+\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordCount(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 0);
}

function uniqueCount(values: string[]): number {
  return new Set(values.filter(Boolean)).size;
}

function traceText(trace: GuiAgentTrace): string {
  return normalizeText(
    trace.steps
      .map((step) => [step.observationSummary, step.structuredRationale, step.agentOutputExcerpt, step.target.label, step.stateAfter].join(" "))
      .join(" "),
  );
}

function taskText(task: GuiAgentTask): string {
  return normalizeText(
    [
      task.taskId,
      task.title,
      task.instruction,
      task.domain,
      task.successCriteria,
      task.textState,
      task.visualState,
      task.benchmark,
      task.site,
      task.sourceCollection,
      ...task.riskTags,
      ...task.traces.map((trace) => [trace.modelId, trace.actorType, trace.observationMode, trace.outcome, trace.sourceCollection].join(" ")),
    ].join(" "),
  );
}

function traceStates(trace: GuiAgentTrace): string[] {
  return trace.steps.map((step) => normalizeText(step.stateSignature || step.stateAfter || step.url || step.visualFingerprint)).filter(Boolean);
}

function traceActionTerms(trace: GuiAgentTrace): string[] {
  return trace.steps.map((step) => normalizeText(`${step.actionType} ${step.target.label}`).split(" ").slice(0, 4).join(" ")).filter(Boolean);
}

function repeatedStateRatio(trace: GuiAgentTrace): number {
  const states = traceStates(trace);
  if (states.length <= 1) return 0;
  return 1 - uniqueCount(states) / states.length;
}

function actionDiversity(trace: GuiAgentTrace): number {
  if (trace.steps.length === 0) return 0;
  return uniqueCount(trace.steps.map((step) => step.actionType)) / Math.min(trace.steps.length, 6);
}

function scoreBacktracking(trace: GuiAgentTrace): number {
  const text = traceText(trace);
  const explicit = keywordCount(text, [/\bgo_back\b/g, /\bbacktrack\w*\b/g, /\bgo back\b/g, /\bprevious\b/g, /\btry (?:a )?different\b/g, /\balternative\w*\b/g]);
  const backActions = trace.steps.filter((step) => /\b(back|previous|return)\b/i.test(`${step.actionType} ${step.target.label} ${step.agentOutputExcerpt ?? ""}`)).length;
  const repeated = repeatedStateRatio(trace);
  return clampScore(1 + Math.min(3, explicit * 0.75 + backActions * 0.65 + repeated * 2.5));
}

function scoreTaskDecomposition(task: GuiAgentTask, trace: GuiAgentTrace): number {
  const firstSteps = trace.steps.slice(0, 3);
  const earlyText = normalizeText(firstSteps.map((step) => [step.structuredRationale, step.agentOutputExcerpt].join(" ")).join(" "));
  const taskComplexity = keywordCount(normalizeText(task.instruction), [
    /\band\b/g,
    /\bthen\b/g,
    /\bbefore\b/g,
    /\bmost\b/g,
    /\brecent\w*\b/g,
    /\bexpensive\b/g,
    /\brating\b/g,
    /\bcategory\b/g,
  ]);
  const planning = keywordCount(earlyText, [/\bstep by step\b/g, /\bfirst\b/g, /\bthen\b/g, /\bnext\b/g, /\bplan\b/g, /\bneed to\b/g, /\bto (?:find|complete|determine)\b/g]);
  return clampScore(1 + Math.min(3, planning * 0.5 + Math.min(taskComplexity, 5) * 0.18));
}

function scoreObservationReading(trace: GuiAgentTrace): number {
  if (trace.steps.length === 0) return 1;
  const avgObservationLength = trace.steps.reduce((sum, step) => sum + normalizeText(step.observationSummary).length, 0) / trace.steps.length;
  const observationReferences = keywordCount(traceText(trace), [/\bobserve\w*\b/g, /\bvisible\b/g, /\bpage shows\b/g, /\bprovided screenshot\b/g, /\baccessibility tree\b/g, /\blisting\w*\b/g]);
  const targetSpecificity = trace.steps.filter((step) => normalizeText(step.target.label).length > 12 && !/\belement \d+\b/.test(normalizeText(step.target.label))).length;
  return clampScore(1 + Math.min(3, avgObservationLength / 260 + observationReferences * 0.18 + (targetSpecificity / Math.max(1, trace.steps.length)) * 1.1));
}

function scoreSelfVerification(trace: GuiAgentTrace): number {
  const text = traceText(trace);
  const checks = keywordCount(text, [/\bverify\w*\b/g, /\bcheck\w*\b/g, /\bconfirm\w*\b/g, /\bensure\w*\b/g, /\bmatch(?:es)?\b/g, /\bfinal answer\b/g, /\bcomplete(?:s|d)?\b/g]);
  const stopLike = keywordCount(text, [/\bin summary\b/g, /\btherefore\b/g, /\banswer\b/g]);
  return clampScore(1 + Math.min(3, checks * 0.45 + stopLike * 0.18));
}

function scoreObjectiveQuality(task: GuiAgentTask): number {
  const text = normalizeText(`${task.instruction} ${task.successCriteria}`);
  const concrete = keywordCount(text, [
    /\bmost\b/g,
    /\brecent\w*\b/g,
    /\bnewest\b/g,
    /\bexpensive\b/g,
    /\bnumber\b/g,
    /\bhow many\b/g,
    /\brating\b/g,
    /\bcategory\b/g,
    /\bsection\b/g,
    /\bfind\b/g,
    /\btell me\b/g,
  ]);
  const quoted = (task.instruction.match(/"[^"]{2,80}"/g) ?? []).length;
  const numeric = (text.match(/\b\d+(?:\.\d+)?\b/g) ?? []).length;
  const lengthSignal = Math.min(text.length / 120, 1);
  return clampScore(1 + Math.min(3, concrete * 0.22 + quoted * 0.35 + numeric * 0.25 + lengthSignal));
}

function scoreStateTransition(trace: GuiAgentTrace): number {
  const repeated = repeatedStateRatio(trace);
  const diversity = actionDiversity(trace);
  const navigation = trace.steps.filter((step) => step.actionType === "navigate" || /\bnavigate|search|sort|filter|login\b/i.test(step.target.label)).length;
  return clampScore(1 + Math.min(3, repeated * 1.8 + diversity * 0.9 + navigation * 0.2));
}

function scoreVisualEvidence(trace: GuiAgentTrace): number {
  if (trace.steps.length === 0) return trace.observationMode === "vision" || trace.observationMode === "mixed" ? 2.2 : 1;
  const frameRatio = trace.steps.filter((step) => step.thumbnailRef || step.screenshotRef || step.visualFrameAvailable).length / trace.steps.length;
  const modeBonus = trace.observationMode === "vision" ? 0.8 : trace.observationMode === "mixed" ? 0.55 : 0;
  return clampScore(1 + frameRatio * 2.2 + modeBonus);
}

function aggregate(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => b - a);
  return clampScore(sorted.slice(0, Math.min(2, sorted.length)).reduce((sum, value) => sum + value, 0) / Math.min(2, sorted.length));
}

function topTerms(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length > 2 && !["the", "and", "for", "with", "page", "action", "browser"].includes(token))
      .forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

export function diagnoseTask(task: GuiAgentTask, staticPath?: string): DiagnosticTaskRow {
  const traces = task.traces ?? [];
  const scores: TraceDiagnosticScores = {
    backtracking_exploration: aggregate(traces.map(scoreBacktracking)),
    task_decomposition: aggregate(traces.map((trace) => scoreTaskDecomposition(task, trace))),
    observation_reading: aggregate(traces.map(scoreObservationReading)),
    self_verification: aggregate(traces.map(scoreSelfVerification)),
    objective_quality: scoreObjectiveQuality(task),
    state_transition: aggregate(traces.map(scoreStateTransition)),
    visual_evidence: aggregate(traces.map(scoreVisualEvidence)),
  };
  const stepCount = traces.reduce((sum, trace) => sum + trace.steps.length, 0);
  const tags = dimensionOrder.filter((dimension) => scores[dimension] >= 3.2);
  return {
    taskId: task.taskId,
    title: task.title,
    instruction: task.instruction,
    benchmark: task.benchmark,
    site: task.site,
    sourceCollection: task.sourceCollection,
    staticPath,
    scores,
    tags,
    actionTerms: topTerms(traces.flatMap(traceActionTerms), 12),
    stateTerms: topTerms(traces.flatMap((trace) => trace.steps.map((step) => `${step.stateAfter} ${step.observationSummary}`)), 12),
    runCount: traces.length,
    stepCount,
  };
}

function rowText(row: DiagnosticTaskRow): string {
  return normalizeText(
    [
      row.taskId,
      row.title,
      row.instruction,
      row.benchmark,
      row.site,
      row.sourceCollection,
      ...row.tags,
      ...row.actionTerms,
      ...row.stateTerms,
    ].join(" "),
  );
}

export function rankDiagnosticRows(rows: DiagnosticTaskRow[], options: DiagnosticSearchOptions): DiagnosticTaskRow[] {
  const taskNeedle = normalizeText(options.taskQuery);
  const patternNeedle = normalizeText(options.pattern);
  return rows
    .map((row) => {
      const text = rowText(row);
      if (taskNeedle && !text.includes(taskNeedle)) return null;
      if (patternNeedle && !text.includes(patternNeedle)) return null;
      const score = row.scores[options.dimension] ?? 1;
      if (score < options.minScore) return null;
      const patternBoost = patternNeedle ? 0.25 : 0;
      return { row, rank: score + patternBoost + Math.min(row.stepCount / 100, 0.2) };
    })
    .filter((value): value is { row: DiagnosticTaskRow; rank: number } => Boolean(value))
    .sort((a, b) => b.rank - a.rank || a.row.taskId.localeCompare(b.row.taskId))
    .map(({ row }) => row);
}

export function buildDiagnosticRows(tasks: Array<GuiAgentTask & { staticPath?: string }>): DiagnosticTaskRow[] {
  return tasks.map((task) => diagnoseTask(task, task.staticPath));
}

