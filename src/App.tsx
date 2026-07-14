import { useEffect, useMemo, useState } from "react";
import { AnalystPilotApp } from "./experiments/analyst-pilot/AnalystPilotApp.js";
import { HumanGoldSubsetApp } from "./experiments/human-gold-subset/HumanGoldSubsetApp.js";
import { guiAgentTasks } from "./projectData.js";
import { analyzeGuiAgentTraces } from "./projectLogic.js";
import {
  appendTraceToTask,
  buildSplitPathLayout,
  mergeTasks,
  parsePastedTrajectory,
  shortText,
  type CanvasNode,
  type LlmProvider,
  type ParsedPasteResult,
} from "./traceWorkbench.js";
import {
  buildDiagnosticRows,
  rankDiagnosticRows,
  type AgentDiagnoseDimension,
  type DiagnosticTaskRow,
} from "./traceDiagnostics.js";
import type { GuiAgentTask, GuiAgentTrace, GuiTraceAnalysis } from "./projectTypes.js";

type Language = "zh" | "en";
type SideTab = "library" | "paste" | "cases";

type StaticLibraryIndex = {
  schemaVersion: string;
  totals?: {
    taskCount?: number;
    comparableTaskCount?: number;
    runCount?: number;
    stepCount?: number;
  };
  tasks?: Array<GuiAgentTask & { staticPath?: string }>;
};

type StaticDiagnosticsIndex = {
  schemaVersion: string;
  rows?: DiagnosticTaskRow[];
};

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
  interpretation?: {
    en?: string;
    zh?: string;
  };
  taskId: string;
  staticPath?: string;
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

type StaticResearchCasesIndex = {
  schemaVersion: string;
  cases?: ResearchCase[];
};

const visibleSearchResultLimit = 100;
const appBaseUrl = import.meta.env.BASE_URL || "/";
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function appUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:|embedded:|zip:)/i.test(path)) return path;
  const base = appBaseUrl.endsWith("/") ? appBaseUrl : `${appBaseUrl}/`;
  const relative = path.replace(/^\/+/, "");
  return `${base}${relative}`;
}

function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return apiBaseUrl ? `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;
}

const copy = {
  zh: {
    title: "TraceFork",
    subtitle: "GUI / Web Agent 轨迹分叉画布",
    tabLibrary: "搜索",
    tabPaste: "粘贴",
    tabCases: "案例",
    guide: "帮助",
    guideTitle: "TraceFork mini guide",
    guideClose: "关闭",
    guidePercent: "百分数",
    guidePercentBody: "节点上的百分数是当前对齐步骤的 divergence score，越高表示两条轨迹在动作、目标、状态或视觉帧上越不一致。",
    guideGeometry: "路径",
    guideGeometryBody: "箭头始终表示时间顺序。两条路径重叠表示状态转移接近；横向分开表示分叉；后续重新靠近表示可能回归。",
    guideUse: "用法",
    guideUseBody: "右侧可以搜索任务、点选典型案例或粘贴 trajectory。生成后悬停节点查看动作、agent output 与页面帧。",
    pasteTitle: "粘贴解析 trajectory",
    libraryTitle: "搜索轨迹库并生成对比",
    language: "EN",
    pasteLabel: "Raw trajectory / JSON",
    pastePlaceholder: "Paste logs, HTML, JSON, image URLs, or data URLs...",
    attachFrames: "Step frames",
    attachFramesHint: "Images stay in this session.",
    chooseFrames: "Choose images",
    noFrames: "No images selected",
    framesSelected: "images selected",
    provider: "解析模型",
    apiKey: "临时 API Key",
    apiKeyPlaceholder: "可选；留空则使用后端环境变量",
    modelName: "解析后 run 名称",
    parse: "解析并加入当前任务",
    parseNoKey: "本地解析",
    search: "搜索 WebArena 任务",
    searchPlaceholder: "关键词、站点、模型、任务描述...",
    diagnose: "AgentDiagnose 检索",
    diagnoseStepOne: "语义 embedding 选择",
    diagnoseStepTwo: "动作关键词",
    diagnoseDimension: "诊断维度",
    diagnoseMinScore: "最低分",
    diagnosePattern: "行为/状态词",
    diagnosePatternPlaceholder: "例如 backtrack, login, verify, category...",
    diagnoseApply: "按诊断检索",
    researchCases: "典型轨迹库",
    researchCasesHint: "20 个真实高价值对比",
    missing: "缺失",
    overlap: "重叠",
    maxDiv: "偏移",
    persistentShort: "持续",
    rejoinShort: "回归",
    selectedCluster: "Selected",
    task: "任务",
    runA: "Run A",
    runB: "Run B",
    generate: "生成对比",
    regenerate: "重新生成",
    emptyTitle: "选择或粘贴 trajectory 后生成对比",
    emptyBody: "生成后，任务描述会作为根节点，两条不同颜色的路径从这里向下分叉；偏移越大，横向距离越大，但会限制在可读范围内。",
    noResults: "暂无搜索结果，使用内置样例作为本地 fallback。",
    selected: "已选择",
    steps: "步",
    divergence: "最大偏移",
    rejoin: "回归",
    persistent: "持续偏移",
    yes: "是",
    no: "否",
    noRejoin: "未回归",
    boundary: "边界：只抽取可观察动作、目标、URL 与状态；不展示或分析 private reasoning / chain-of-thought。",
    parsedTask: "已导入任务包",
    parsedTrace: "已加入单条 trajectory",
    parseFailed: "解析失败",
    dbFallback: "线上库不可用，正在使用本地样例搜索。",
    dbLoaded: "已加载线上/本地轨迹库结果。",
    staticLoaded: "已加载真实静态轨迹库",
    staticFailed: "真实静态轨迹库不可用，使用 API / 本地 fallback。",
    frameAvailable: "有帧",
    noComparableRuns: "需要同一任务下至少两条轨迹。",
    arrowLegend: "箭头方向 = 时间顺序，上一步动作 → 下一步动作",
    laneLegendA: "蓝色 Run A",
    laneLegendB: "绿色 Run B",
    dashedLegend: "虚线 = 靠近/回归或缺失帧",
    hoverHint: "悬停查看动作、状态、agent output 与截图",
    target: "目标",
    observation: "观察",
    agentOutput: "Agent output",
    frames: "页面帧",
  },
  en: {
    title: "TraceFork",
    subtitle: "GUI / Web agent inspection tree",
    tabLibrary: "Search",
    tabPaste: "Paste",
    tabCases: "Cases",
    guide: "Guide",
    guideTitle: "TraceFork mini guide",
    guideClose: "Close",
    guidePercent: "Percentages",
    guidePercentBody: "The percentage on a node is the divergence score for the aligned step. Higher means the two runs disagree more in action, target, state, or visual frame.",
    guideGeometry: "Paths",
    guideGeometryBody: "Arrows always show time order. Overlap means similar state transitions; horizontal separation means divergence; later narrowing means possible rejoin.",
    guideUse: "How to use",
    guideUseBody: "Use the right rail to search tasks, pick a research case, or paste a trajectory. After generation, hover nodes to inspect actions, agent output, and page frames.",
    pasteTitle: "Paste and parse trajectory",
    libraryTitle: "Search trajectory library and compare",
    language: "中文",
    pasteLabel: "Raw trajectory / JSON",
    pastePlaceholder: "Paste logs, HTML, JSON, image URLs, or data URLs...",
    attachFrames: "Step frames",
    attachFramesHint: "Images stay in this session.",
    chooseFrames: "Choose images",
    noFrames: "No images selected",
    framesSelected: "images selected",
    provider: "Parser model",
    apiKey: "Temporary API key",
    apiKeyPlaceholder: "Optional; empty uses server env key",
    modelName: "Parsed run name",
    parse: "Parse and add to task",
    parseNoKey: "Parse locally",
    search: "Search WebArena tasks",
    searchPlaceholder: "Keyword, site, model, task instruction...",
    diagnose: "AgentDiagnose retrieval",
    diagnoseStepOne: "Select with semantic embeddings",
    diagnoseStepTwo: "Action terms",
    diagnoseDimension: "Diagnostic dimension",
    diagnoseMinScore: "Min score",
    diagnosePattern: "Behavior/state term",
    diagnosePatternPlaceholder: "e.g. backtrack, login, verify, category...",
    diagnoseApply: "Retrieve by diagnosis",
    researchCases: "Research cases",
    researchCasesHint: "20 high-value real comparisons",
    missing: "Missing",
    overlap: "Overlap",
    maxDiv: "Div.",
    persistentShort: "Persistent",
    rejoinShort: "Rejoin",
    selectedCluster: "Selected task",
    task: "Task",
    runA: "Run A",
    runB: "Run B",
    generate: "Generate comparison",
    regenerate: "Regenerate",
    emptyTitle: "Select or paste trajectories, then generate",
    emptyBody: "The task is the root node. Two colored paths branch downward; larger divergence creates wider horizontal separation within a readable cap.",
    noResults: "No search results yet; built-in samples are used as local fallback.",
    selected: "Selected",
    steps: "steps",
    divergence: "Max divergence",
    rejoin: "Rejoin",
    persistent: "Persistent",
    yes: "Yes",
    no: "No",
    noRejoin: "No rejoin",
    boundary: "Boundary: extracts observable actions, targets, URLs, and states only; no private reasoning or chain-of-thought analysis.",
    parsedTask: "Imported task bundle",
    parsedTrace: "Added single trajectory",
    parseFailed: "Parse failed",
    dbFallback: "Online library unavailable; using local sample search.",
    dbLoaded: "Loaded online/local trajectory results.",
    staticLoaded: "Loaded real static trajectory library",
    staticFailed: "Real static trajectory library unavailable; using API / local fallback.",
    frameAvailable: "Frame",
    noComparableRuns: "At least two runs from the same task are required.",
    arrowLegend: "Arrow direction = time order, previous action → next action",
    laneLegendA: "Blue Run A",
    laneLegendB: "Green Run B",
    dashedLegend: "Dashed = converging/rejoin or missing frame",
    hoverHint: "Hover for action, state, agent output, and screenshots",
    target: "Target",
    observation: "Observation",
    agentOutput: "Agent output",
    frames: "Page frames",
  },
} satisfies Record<Language, Record<string, string>>;

const providerOptions: Array<{ value: LlmProvider | "local"; label: string }> = [
  { value: "local", label: "Local heuristic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
];

const diagnoseDimensions: Array<{ value: AgentDiagnoseDimension; labels: Record<Language, string> }> = [
  { value: "backtracking_exploration", labels: { zh: "回退 / 探索", en: "Backtracking / exploration" } },
  { value: "task_decomposition", labels: { zh: "任务分解", en: "Task decomposition" } },
  { value: "observation_reading", labels: { zh: "观察读取", en: "Observation reading" } },
  { value: "self_verification", labels: { zh: "自我验证", en: "Self-verification" } },
  { value: "objective_quality", labels: { zh: "目标质量", en: "Objective quality" } },
  { value: "state_transition", labels: { zh: "状态转移 / 循环", en: "State transition / loops" } },
  { value: "visual_evidence", labels: { zh: "视觉证据", en: "Visual evidence" } },
];

type EmbeddingPoint = {
  taskId: string;
  label: string;
  x: number;
  y: number;
  score: number;
  active: boolean;
};

type ActionChip = {
  term: string;
  size: "sm" | "md" | "lg";
  tone: number;
  active: boolean;
};

function uniqueTraceB(task: GuiAgentTask, traceAId: string, traceBId: string): GuiAgentTrace {
  const traceA = task.traces.find((trace) => trace.traceId === traceAId) ?? task.traces[0];
  return (
    task.traces.find((trace) => trace.traceId === traceBId && trace.traceId !== traceA.traceId) ??
    task.traces.find((trace) => trace.traceId !== traceA.traceId) ??
    task.traces[0]
  );
}

function eventLabel(event: GuiTraceAnalysis["comparisons"][number]["event"] | "task", language: Language): string {
  const labels = {
    zh: {
      task: "任务起点",
      stable: "稳定",
      diverged: "分叉",
      converging: "靠近",
      rejoined: "回归",
      persistent_divergence: "持续偏移",
    },
    en: {
      task: "Task root",
      stable: "Stable",
      diverged: "Diverged",
      converging: "Converging",
      rejoined: "Rejoined",
      persistent_divergence: "Persistent",
    },
  } satisfies Record<Language, Record<typeof event, string>>;
  return labels[language][event];
}

function displayableImageRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (/^(data:image\/|https?:\/\/)/i.test(ref)) return ref;
  if (ref.startsWith("/")) return appUrl(ref);
  return undefined;
}

function compactMeta(parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => Boolean(part && part !== "unknown")).join(" / ");
}

function traceLabel(trace: GuiAgentTrace): string {
  const suffix = compactMeta([trace.actorType, trace.observationMode, trace.outcome, trace.promptSetting]);
  return suffix ? `${trace.modelId} · ${suffix}` : trace.modelId;
}

function scorePercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function compactPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function researchCaseMetric(caseRow: ResearchCase, language: Language): string {
  const t = copy[language];
  if (caseRow.kind === "high_overlap") return `${t.overlap} ${compactPercent(caseRow.metrics.overlapRate)}`;
  if (caseRow.kind === "strong_rejoin" || caseRow.kind === "long_recovery") {
    return caseRow.metrics.rejoinStep === null ? t.noRejoin : `${t.rejoinShort} ${caseRow.metrics.rejoinStep}`;
  }
  if (caseRow.kind === "persistent_divergence") return `${t.persistentShort} ${compactPercent(caseRow.metrics.maxDivergence)}`;
  return `${t.maxDiv} ${compactPercent(caseRow.metrics.maxDivergence)}`;
}

function researchCaseTitle(caseRow: ResearchCase): string {
  return [
    caseRow.label,
    caseRow.interpretation?.en,
    caseRow.pairKind,
    `${caseRow.runALabel} vs ${caseRow.runBLabel}`,
    `missing ${compactPercent(caseRow.metrics.missingRate)}`,
    `overlap ${compactPercent(caseRow.metrics.overlapRate)}`,
    `max divergence ${compactPercent(caseRow.metrics.maxDivergence)}`,
  ].join(" · ");
}

function researchCaseInterpretation(caseRow: ResearchCase, language: Language): string {
  const text = caseRow.interpretation?.[language];
  if (text) return text;
  if (caseRow.kind === "high_overlap") {
    return language === "zh" ? "该值表示两条轨迹大部分步骤仍保持可比。" : "This value means most steps remain comparable across the two runs.";
  }
  if (caseRow.kind === "strong_rejoin" || caseRow.kind === "long_recovery") {
    return language === "zh" ? "该值表示分叉后重新回到可比状态的位置。" : "This value marks where the runs return to a comparable state after a split.";
  }
  return language === "zh"
    ? "该值表示两条轨迹在动作、目标或状态上的最大可观察差异。"
    : "This value summarizes the largest observable action, target, or state difference.";
}

function isDisplayableResearchCase(caseRow: ResearchCase): boolean {
  if (/\bfailed|failure|early stop|unable to|could not|cannot|not found|same action\b/i.test(`${caseRow.label} ${caseRow.kind} ${caseRow.runALabel} ${caseRow.runBLabel}`)) {
    return false;
  }
  if (caseRow.metrics.missingRate > 0.3) return false;
  if (caseRow.metrics.stepPairs < 4) return false;
  return true;
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isComparableTask(task: GuiAgentTask): boolean {
  return task.traces.length >= 2;
}

function taskRunSummary(task: GuiAgentTask, language: Language): string {
  if (task.traces.length === 0) return language === "zh" ? "点击加载 runs" : "Click to load runs";
  const humanCount = task.traces.filter((trace) => trace.actorType === "human" || trace.agentKind === "human").length;
  const modelCount = task.traces.length - humanCount;
  const successCount = task.traces.filter((trace) => trace.outcome === "success").length;
  const failedCount = task.traces.filter((trace) => trace.outcome === "failed").length;
  const outcome = successCount || failedCount ? `${successCount} success / ${failedCount} failed` : "outcome unknown";
  return `${task.traces.length} runs · ${modelCount} model / ${humanCount} human · ${outcome}`;
}

function taskSourceLabel(task: GuiAgentTask): string {
  return compactMeta([task.benchmark, task.site, task.sourceCollection]) || task.domain;
}

function taskQuestion(task: GuiAgentTask, max = 170): string {
  const instruction = task.instruction.replace(/^Inspect (official|human) trajectory for [^.]+\./i, "").trim();
  const title = task.title.replace(/^Task\s+\d+:\s*/i, "").trim();
  const state = task.textState || task.visualState;
  const category = state.match(/\[(?:IMG|BUTTON|LINK|TEXTBOX)[^\]]*\]\s*([^,\n]{8,90})/i)?.[1];
  return shortText(instruction || title || category || task.successCriteria || task.domain, max);
}

function tasksFromDiagnosticRows(rows: DiagnosticTaskRow[], taskPool: GuiAgentTask[]): GuiAgentTask[] {
  const byId = new Map(taskPool.map((task) => [task.taskId, task]));
  return rows.map((row) => byId.get(row.taskId)).filter((task): task is GuiAgentTask => Boolean(task));
}

function normalizeChipTerm(term: string): string {
  return term
    .replace(/\b(?:observable|target|browser|navigate|internal|role|label|text|attr|page|action)\b/gi, " ")
    .replace(/[^a-z0-9+ -]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chipTermFromActionTerm(term: string): string | null {
  const normalized = normalizeChipTerm(term);
  if (!normalized) return null;
  const parts = normalized.split(/\s+/).filter((part) => part.length > 2);
  if (parts.length === 0) return null;
  return parts.slice(0, 4).join(" ");
}

function buildActionChips(rows: DiagnosticTaskRow[], selectedTaskId: string, activeTerm: string): ActionChip[] {
  const selected = rows.find((row) => row.taskId === selectedTaskId);
  const orderedRows = selected ? [selected, ...rows.filter((row) => row.taskId !== selectedTaskId)] : rows;
  const counts = new Map<string, number>();
  orderedRows.slice(0, 160).forEach((row, rowIndex) => {
    const terms = [...row.actionTerms, ...row.stateTerms.slice(0, 4)];
    terms.forEach((term) => {
      const chip = chipTermFromActionTerm(term);
      if (!chip || chip.length < 3 || chip.length > 34) return;
      const weight = row.taskId === selectedTaskId ? 4 : rowIndex < 16 ? 2 : 1;
      counts.set(chip, (counts.get(chip) ?? 0) + weight);
    });
  });
  const active = activeTerm.toLowerCase();
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([term, count], index) => ({
      term,
      size: count >= 8 ? "lg" : count >= 4 ? "md" : "sm",
      tone: hashNumber(`${term}-${index}`) % 7,
      active: Boolean(active && term.toLowerCase().includes(active)),
    }));
}

function buildEmbeddingPoints(
  rows: DiagnosticTaskRow[],
  taskPool: GuiAgentTask[],
  selectedTaskId: string,
  dimension: AgentDiagnoseDimension,
  language: Language,
): EmbeddingPoint[] {
  const taskById = new Map(taskPool.map((task) => [task.taskId, task]));
  const uniqueRows = [...new Map(rows.map((row) => [row.taskId, row])).values()];
  const selectedRow = uniqueRows.find((row) => row.taskId === selectedTaskId);
  const displayedRows = selectedRow
    ? [selectedRow, ...uniqueRows.filter((row) => row.taskId !== selectedTaskId)].slice(0, 120)
    : uniqueRows.slice(0, 120);
  const activeTaskId = selectedRow?.taskId ?? displayedRows[0]?.taskId;
  return displayedRows.map((row) => {
    const hash = hashNumber(`${row.taskId}-${dimension}`);
    const xScore = row.scores[dimension] ?? 1;
    const yScore = Math.max(row.scores.visual_evidence ?? 1, row.scores.state_transition ?? 1);
    const task = taskById.get(row.taskId);
    const baseX = 8 + ((hash % 1000) / 999) * 84;
    const baseY = 8 + (((hash >>> 10) % 1000) / 999) * 84;
    const scorePullX = ((xScore - 2.5) / 1.5) * 10;
    const scorePullY = -((yScore - 2.5) / 1.5) * 10;
    return {
      taskId: row.taskId,
      label: task ? taskQuestion(task, 110) : shortText(row.instruction || row.title, 110),
      x: clamp(baseX + scorePullX, 5, 95),
      y: clamp(baseY + scorePullY, 6, 94),
      score: xScore,
      active: row.taskId === activeTaskId,
    };
  });
}

function staticPathForTask(task: GuiAgentTask): string | undefined {
  const maybeStatic = task as GuiAgentTask & { staticPath?: string };
  return maybeStatic.staticPath;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });
}

function libraryStatus(prefix: string, index: StaticLibraryIndex): string {
  const totals = index.totals;
  if (!totals) return prefix;
  return `${prefix}: ${totals.taskCount ?? 0} tasks / ${totals.runCount ?? 0} runs / ${totals.stepCount ?? 0} steps / ${
    totals.comparableTaskCount ?? 0
  } comparable`;
}

async function parseWithApi(
  rawText: string,
  provider: LlmProvider | "local",
  apiKey: string,
  modelName: string,
  selectedTask: GuiAgentTask,
): Promise<ParsedPasteResult> {
  if (provider === "local") {
    return parsePastedTrajectory(rawText, selectedTask, modelName);
  }

  try {
    const response = await fetch(apiUrl("/api/trajectory/parse-paste"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rawText,
        provider,
        apiKey,
        modelName,
        task: {
          taskId: selectedTask.taskId,
          title: selectedTask.title,
          instruction: selectedTask.instruction,
          domain: selectedTask.domain,
          startUrl: selectedTask.startUrl,
          successCriteria: selectedTask.successCriteria,
          screenshotSize: selectedTask.screenshotSize,
        },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as ParsedPasteResult;
  } catch {
    return parsePastedTrajectory(rawText, selectedTask, modelName);
  }
}

function App() {
  const experimentMode = new URLSearchParams(window.location.search).get("experiment");
  if (experimentMode === "gold") return <HumanGoldSubsetApp />;
  if (experimentMode === "pilot") return <AnalystPilotApp />;

  const [language, setLanguage] = useState<Language>("en");
  const t = copy[language];
  const [guideOpen, setGuideOpen] = useState(false);
  const [activeSideTab, setActiveSideTab] = useState<SideTab>("library");
  const initialTasks = useMemo(() => guiAgentTasks.filter(isComparableTask), []);
  const initialTask = initialTasks[0] ?? guiAgentTasks[0];
  const [tasks, setTasks] = useState<GuiAgentTask[]>(initialTasks.length ? initialTasks : guiAgentTasks);
  const [searchResults, setSearchResults] = useState<GuiAgentTask[]>(initialTasks.length ? initialTasks : guiAgentTasks);
  const [selectedTaskId, setSelectedTaskId] = useState(initialTask.taskId);
  const [traceAId, setTraceAId] = useState(initialTask.traces[0].traceId);
  const [traceBId, setTraceBId] = useState(initialTask.traces[1]?.traceId ?? initialTask.traces[0].traceId);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [rawText, setRawText] = useState("");
  const [provider, setProvider] = useState<LlmProvider | "local">("local");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("pasted-run");
  const [attachedFrameCount, setAttachedFrameCount] = useState(0);
  const [query, setQuery] = useState("");
  const [diagnoseDimension, setDiagnoseDimension] = useState<AgentDiagnoseDimension>("backtracking_exploration");
  const [diagnoseMinScore, setDiagnoseMinScore] = useState("3");
  const [diagnosePattern, setDiagnosePattern] = useState("");
  const [hoveredEmbeddingLabel, setHoveredEmbeddingLabel] = useState("");
  const [staticLibrary, setStaticLibrary] = useState<StaticLibraryIndex | null>(null);
  const [staticDiagnostics, setStaticDiagnostics] = useState<StaticDiagnosticsIndex | null>(null);
  const [researchCases, setResearchCases] = useState<ResearchCase[]>([]);
  const [status, setStatus] = useState(t.noResults);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0],
    [selectedTaskId, tasks],
  );
  const traceA = useMemo(
    () => selectedTask.traces.find((trace) => trace.traceId === traceAId) ?? selectedTask.traces[0],
    [selectedTask, traceAId],
  );
  const traceB = useMemo(() => uniqueTraceB(selectedTask, traceA.traceId, traceBId), [selectedTask, traceA.traceId, traceBId]);
  const analysis = useMemo(() => analyzeGuiAgentTraces(selectedTask, traceA, traceB), [selectedTask, traceA, traceB]);
  const layout = useMemo(
    () => (hasGenerated ? buildSplitPathLayout(selectedTask, traceA, traceB, analysis) : null),
    [analysis, hasGenerated, selectedTask, traceA, traceB],
  );
  const diagnosticPool = useMemo(() => (staticLibrary?.tasks?.length ? staticLibrary.tasks : tasks), [staticLibrary, tasks]);
  const diagnosticRows = useMemo(
    () => (staticDiagnostics?.rows?.length ? staticDiagnostics.rows : buildDiagnosticRows(diagnosticPool)),
    [diagnosticPool, staticDiagnostics],
  );
  const visibleDiagnosticRows = useMemo(() => {
    const visibleIds = new Set(searchResults.map((task) => task.taskId));
    const visibleRows = diagnosticRows.filter((row) => visibleIds.has(row.taskId));
    return visibleRows.length ? visibleRows : diagnosticRows;
  }, [diagnosticRows, searchResults]);
  const embeddingRows = useMemo(
    () =>
      rankDiagnosticRows(visibleDiagnosticRows, {
        dimension: diagnoseDimension,
        minScore: Math.min(2, Number(diagnoseMinScore) || 2),
        taskQuery: query,
      }),
    [diagnoseDimension, diagnoseMinScore, query, visibleDiagnosticRows],
  );
  const embeddingPoints = useMemo(
    () => buildEmbeddingPoints(embeddingRows, diagnosticPool, selectedTask.taskId, diagnoseDimension, language),
    [diagnoseDimension, diagnosticPool, embeddingRows, language, selectedTask.taskId],
  );
  const actionChips = useMemo(
    () => buildActionChips(embeddingRows.length ? embeddingRows : diagnosticRows, selectedTask.taskId, diagnosePattern),
    [diagnosePattern, diagnosticRows, embeddingRows, selectedTask.taskId],
  );

  async function hydrateTask(task: GuiAgentTask): Promise<GuiAgentTask> {
    if (task.traces.length >= 2 && task.traces.every((trace) => trace.steps.length > 0)) return task;
    const staticPath = staticPathForTask(task);
    if (staticPath) {
      try {
        const response = await fetch(appUrl(staticPath) ?? staticPath);
        if (response.ok) {
          return (await response.json()) as GuiAgentTask;
        }
      } catch {
        // Fall through to the API route below.
      }
    }
    try {
      const response = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(task.taskId)}/runs`));
      if (!response.ok) return task;
      const payload = (await response.json()) as { ok?: boolean; task?: GuiAgentTask };
      return payload.ok && payload.task ? payload.task : task;
    } catch {
      return task;
    }
  }

  async function chooseTask(task: GuiAgentTask) {
    const hydratedTask = await hydrateTask(task);
    if (hydratedTask.traces.length === 0) {
      setStatus(language === "zh" ? "这个任务还没有可读取的轨迹步骤。" : "This task has no readable trajectory runs yet.");
      return;
    }
    setTasks((current) => mergeTasks(current, [hydratedTask]));
    setSelectedTaskId(hydratedTask.taskId);
    setTraceAId(hydratedTask.traces[0]?.traceId ?? "");
    setTraceBId(hydratedTask.traces[1]?.traceId ?? hydratedTask.traces[0]?.traceId ?? "");
    setHasGenerated(hydratedTask.traces.length >= 2);
    if (hydratedTask.traces.length < 2) {
      setStatus(t.noComparableRuns);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadLibrary() {
      try {
        const response = await fetch(appUrl("/trajectory-library/index.json") ?? "/trajectory-library/index.json");
        if (!response.ok) throw new Error("static library unavailable");
        const index = (await response.json()) as StaticLibraryIndex;
        const libraryTasks = (Array.isArray(index.tasks) ? index.tasks : []).filter(isComparableTask);
        if (libraryTasks.length === 0) throw new Error("static library is empty");
        if (cancelled) return;
        setStaticLibrary(index);
        void fetch(appUrl("/trajectory-library/diagnostics.json") ?? "/trajectory-library/diagnostics.json")
          .then((diagnosticsResponse) => (diagnosticsResponse.ok ? diagnosticsResponse.json() : null))
          .then((diagnostics: StaticDiagnosticsIndex | null) => {
            if (!cancelled && diagnostics?.rows?.length) setStaticDiagnostics(diagnostics);
          })
          .catch(() => {
            // Diagnostics are an optional search accelerator; keyword search still works without them.
          });
        void fetch(appUrl("/trajectory-library/research-cases.json") ?? "/trajectory-library/research-cases.json")
          .then((casesResponse) => (casesResponse.ok ? casesResponse.json() : null))
          .then((casesIndex: StaticResearchCasesIndex | null) => {
            if (!cancelled && Array.isArray(casesIndex?.cases)) setResearchCases(casesIndex.cases.filter(isDisplayableResearchCase).slice(0, 20));
          })
          .catch(() => {
            // Research cases are optional; the search and diagnose flows remain available.
          });
        setTasks((current) => mergeTasks(current, libraryTasks));
        setSearchResults(libraryTasks);
        setStatus(libraryStatus(t.staticLoaded, index));
        const firstComparable = libraryTasks.find((task) => task.traces.length >= 2) ?? libraryTasks[0];
        void chooseTask(firstComparable);
        return;
      } catch {
        if (!cancelled) setStatus(t.staticFailed);
      }
      try {
        const response = await fetch(apiUrl("/api/tasks?query="));
        if (!response.ok) throw new Error("remote library unavailable");
        const payload = (await response.json()) as { ok?: boolean; tasks?: GuiAgentTask[] };
          const remoteTasks = (Array.isArray(payload.tasks) ? payload.tasks : []).filter(isComparableTask);
        if (remoteTasks.length === 0) throw new Error("remote library is empty");
        if (cancelled) return;
        setTasks((current) => mergeTasks(current, remoteTasks));
        setSearchResults(remoteTasks);
        setStatus(`${t.dbLoaded} · ${remoteTasks.length} result(s)`);
        const firstComparable = remoteTasks.find((task) => task.traces.length >= 2) ?? remoteTasks[0];
        void chooseTask(firstComparable);
        return;
      } catch {
        if (!cancelled) setStatus(t.dbFallback);
      }
    }
    void loadLibrary();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyTasks(nextTasks: GuiAgentTask[], preferredTaskId?: string) {
    setTasks(nextTasks);
    const nextTask = nextTasks.find((task) => task.taskId === preferredTaskId) ?? nextTasks[0];
    setSearchResults(nextTasks);
    void chooseTask(nextTask);
  }

  async function handleParsePaste() {
    const result = await parseWithApi(rawText, provider, apiKey, modelName || "pasted-run", selectedTask);
    if (!result.ok) {
      setStatus(`${t.parseFailed}: ${result.errors[0] ?? "unknown error"}`);
      return;
    }
    if (result.mode === "task_bundle") {
      const nextTasks = mergeTasks(tasks, result.tasks);
      applyTasks(nextTasks, result.tasks[0]?.taskId);
      setStatus(`${t.parsedTask}: ${result.tasks.length}`);
      setRawText("");
      return;
    }
    const nextTasks = appendTraceToTask(tasks, selectedTask.taskId, result.trace);
    setTasks(nextTasks);
    setSearchResults(nextTasks);
    setTraceBId(result.trace.traceId);
    setHasGenerated(true);
    setStatus(`${t.parsedTrace}: ${result.trace.modelId} / ${result.trace.steps.length} ${t.steps}`);
    setRawText("");
  }

  async function handleAttachFrames(files: FileList | null) {
    const imageFiles = [...(files ?? [])].filter((file) => /^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type));
    if (imageFiles.length === 0) return;
    try {
      const dataUrls = await Promise.all(imageFiles.slice(0, 12).map(fileToDataUrl));
      const frameBlock = dataUrls.map((url, index) => `[frame ${index + 1}] image: ${url}`).join("\n");
      setRawText((current) => [current.trim(), frameBlock].filter(Boolean).join("\n"));
      setAttachedFrameCount(dataUrls.length);
      setStatus(language === "zh" ? `已附加 ${dataUrls.length} 张页面帧。` : `Attached ${dataUrls.length} page frame(s).`);
    } catch (error) {
      setStatus(`${t.parseFailed}: ${error instanceof Error ? error.message : "image read failed"}`);
    }
  }

  async function handleSearch() {
    const needle = query.trim().toLowerCase();
    if (staticLibrary?.tasks?.length) {
      const filtered = filterTasks(staticLibrary.tasks, needle);
      if (filtered.length > 0 || needle) {
        setSearchResults(filtered);
        setTasks((current) => mergeTasks(current, filtered));
        setStatus(`${libraryStatus(t.staticLoaded, staticLibrary)} · ${filtered.length} result(s)`);
        return;
      }
    }
    try {
      const response = await fetch(apiUrl(`/api/tasks?query=${encodeURIComponent(needle)}`));
      if (!response.ok) throw new Error("search unavailable");
      const payload = (await response.json()) as { ok?: boolean; tasks?: GuiAgentTask[] };
      const remoteTasks = (Array.isArray(payload.tasks) ? payload.tasks : []).filter(isComparableTask);
      const nextTasks = remoteTasks.length > 0 ? mergeTasks(tasks, remoteTasks) : tasks;
      setTasks(nextTasks);
      setSearchResults(remoteTasks.length > 0 ? remoteTasks : filterTasks(nextTasks, needle));
      setStatus(t.dbLoaded);
    } catch {
      if (staticLibrary?.tasks?.length) {
        const filtered = filterTasks(staticLibrary.tasks, needle);
        setSearchResults(filtered);
        setTasks((current) => mergeTasks(current, filtered));
        setStatus(`${libraryStatus(t.staticLoaded, staticLibrary)} · ${filtered.length} result(s)`);
        return;
      }
      setSearchResults(filterTasks(tasks, needle));
      setStatus(t.dbFallback);
    }
  }

  function runDiagnoseSearch(pattern = diagnosePattern, dimension = diagnoseDimension, minScoreValue = diagnoseMinScore) {
    const minScore = Number(minScoreValue) || 3;
    const options = {
      dimension,
      minScore,
      pattern,
      taskQuery: query,
    };
    const rankedRows = rankDiagnosticRows(diagnosticRows, options);
    const filtered = tasksFromDiagnosticRows(rankedRows, diagnosticPool).filter(isComparableTask);
    setSearchResults(filtered);
    setTasks((current) => mergeTasks(current, filtered));
    setStatus(`${copy[language].diagnose}: ${filtered.length} result(s)`);
  }

  function handleDiagnoseSearch() {
    runDiagnoseSearch();
  }

  function handleActionTermSelect(term: string) {
    setDiagnosePattern(term);
  }

  async function chooseResearchCase(caseRow: ResearchCase) {
    const indexedTask =
      tasks.find((task) => task.taskId === caseRow.taskId) ??
      staticLibrary?.tasks?.find((task) => task.taskId === caseRow.taskId);
    if (!indexedTask) {
      setStatus(language === "zh" ? "该典型案例还没有加载到本地索引。" : "This research case is not available in the local index.");
      return;
    }
    const hydratedTask = await hydrateTask(
      { ...indexedTask, staticPath: caseRow.staticPath ?? staticPathForTask(indexedTask) } as GuiAgentTask & { staticPath?: string },
    );
    const nextTraceA = hydratedTask.traces.find((trace) => trace.traceId === caseRow.runAId) ?? hydratedTask.traces[0];
    const nextTraceB =
      hydratedTask.traces.find((trace) => trace.traceId === caseRow.runBId && trace.traceId !== nextTraceA?.traceId) ??
      hydratedTask.traces.find((trace) => trace.traceId !== nextTraceA?.traceId) ??
      hydratedTask.traces[0];
    if (!nextTraceA || !nextTraceB || nextTraceA.traceId === nextTraceB.traceId) {
      setStatus(t.noComparableRuns);
      return;
    }
    setTasks((current) => mergeTasks(current, [hydratedTask]));
    setSelectedTaskId(hydratedTask.taskId);
    setTraceAId(nextTraceA.traceId);
    setTraceBId(nextTraceB.traceId);
    setHasGenerated(true);
    setStatus(`${copy[language].researchCases}: ${caseRow.label} · ${researchCaseMetric(caseRow, language)}`);
  }

  return (
    <main className="tracefork-shell">
      <section className="canvas-panel" aria-label="TraceFork split path canvas">
        <header className="canvas-topbar">
          <div>
            <h1>{t.title}</h1>
            <p>{t.subtitle}</p>
          </div>
          <div className="topbar-actions">
            <a className="experiment-link" href="?experiment=gold">
              Gold
            </a>
            <a className="experiment-link" href="?experiment=pilot">
              Pilot
            </a>
            <button className="guide-toggle" type="button" aria-label={t.guide} onClick={() => setGuideOpen(true)}>
              ?
            </button>
            <button className="language-toggle" type="button" onClick={() => setLanguage((current) => (current === "zh" ? "en" : "zh"))}>
              {t.language}
            </button>
          </div>
        </header>
        {guideOpen ? (
          <div className="guide-popover" role="dialog" aria-modal="false" aria-label={t.guideTitle}>
            <div className="guide-popover-heading">
              <strong>{t.guideTitle}</strong>
              <button type="button" onClick={() => setGuideOpen(false)}>
                {t.guideClose}
              </button>
            </div>
            <dl>
              <div>
                <dt>{t.guidePercent}</dt>
                <dd>{t.guidePercentBody}</dd>
              </div>
              <div>
                <dt>{t.guideGeometry}</dt>
                <dd>{t.guideGeometryBody}</dd>
              </div>
              <div>
                <dt>{t.guideUse}</dt>
                <dd>{t.guideUseBody}</dd>
              </div>
            </dl>
          </div>
        ) : null}
        <div className="path-board" style={{ minHeight: layout?.height ?? 720 }}>
          {!layout ? (
            <div className="canvas-empty-state">
              <strong>{t.emptyTitle}</strong>
              <span>{t.emptyBody}</span>
            </div>
          ) : (
            <SplitPathCanvas layout={layout} language={language} />
          )}
        </div>
        <div className="compare-dock canvas-compare-dock">
          <div className="selected-task">
            <span>{t.selected}</span>
            <strong>{taskQuestion(selectedTask, 150)}</strong>
          </div>
          <div className="run-grid">
            <label className="field">
              <span>{t.runA}</span>
              <select value={traceA.traceId} onChange={(event) => setTraceAId(event.currentTarget.value)}>
                {selectedTask.traces.map((trace) => (
                  <option key={trace.traceId} value={trace.traceId}>
                    {traceLabel(trace)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.runB}</span>
              <select value={traceB.traceId} onChange={(event) => setTraceBId(event.currentTarget.value)}>
                {selectedTask.traces.map((trace) => (
                  <option disabled={trace.traceId === traceA.traceId} key={trace.traceId} value={trace.traceId}>
                    {traceLabel(trace)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary-button compare" type="button" disabled={selectedTask.traces.length < 2} onClick={() => setHasGenerated(true)}>
            {hasGenerated ? t.regenerate : t.generate}
          </button>
        </div>
      </section>

      <aside className="side-panel" aria-label="Trajectory controls">
        <nav className="side-tabs" aria-label="Trajectory control tabs">
          {([
            ["library", t.tabLibrary],
            ["paste", t.tabPaste],
            ["cases", t.tabCases],
          ] as const).map(([tab, label]) => (
            <button
              aria-pressed={activeSideTab === tab}
              className={activeSideTab === tab ? "side-tab active" : "side-tab"}
              key={tab}
              type="button"
              onClick={() => setActiveSideTab(tab)}
            >
              {label}
            </button>
          ))}
        </nav>

        {activeSideTab === "paste" ? (
        <section className="tool-section">
          <div className="section-heading">
            <span>01</span>
            <h2>{t.pasteTitle}</h2>
          </div>
          <label className="field">
            <span>{t.pasteLabel}</span>
            <textarea value={rawText} onChange={(event) => setRawText(event.currentTarget.value)} placeholder={t.pastePlaceholder} />
          </label>
          <label className="field frame-upload">
            <span>{t.attachFrames}</span>
            <div className="file-picker">
              <label className="file-picker-button">
                {t.chooseFrames}
                <input
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  type="file"
                  onChange={(event) => {
                    void handleAttachFrames(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <span>{attachedFrameCount ? `${attachedFrameCount} ${t.framesSelected}` : t.noFrames}</span>
            </div>
            <small>{t.attachFramesHint}</small>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>{t.provider}</span>
              <select value={provider} onChange={(event) => setProvider(event.currentTarget.value as LlmProvider | "local")}>
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.modelName}</span>
              <input value={modelName} onChange={(event) => setModelName(event.currentTarget.value)} />
            </label>
          </div>
          <label className="field">
            <span>{t.apiKey}</span>
            <input
              autoComplete="off"
              disabled={provider === "local"}
              placeholder={t.apiKeyPlaceholder}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
          <button className="primary-button" type="button" onClick={() => void handleParsePaste()}>
            {provider === "local" ? t.parseNoKey : t.parse}
          </button>
        </section>
        ) : null}

        {activeSideTab === "library" ? (
        <section className="tool-section library-section">
          <div className="section-heading">
            <span>02</span>
            <h2>{t.libraryTitle}</h2>
          </div>
          <label className="field search-row">
            <span>{t.search}</span>
            <div>
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t.searchPlaceholder} />
              <button type="button" onClick={() => void handleSearch()}>
                Search
              </button>
            </div>
          </label>
          <div className="diagnose-panel" aria-label={t.diagnose}>
            <div className="diagnose-panel-title">
              <span>{t.diagnose}</span>
              <b>{embeddingRows.length || searchResults.length}</b>
            </div>
            <div className="diagnose-flow">
              <section className="diagnose-step semantic-step" aria-label={t.diagnoseStepOne}>
                <div className="diagnose-step-heading semantic-heading">
                  <span className="diagnose-heading-main">
                    <b>1</b>
                    <span>{t.diagnoseStepOne}</span>
                  </span>
                  <strong className="semantic-selected-summary" title={taskQuestion(selectedTask, 160)}>
                    {t.selectedCluster}: {taskQuestion(selectedTask, 48)}
                  </strong>
                </div>
                <div className="semantic-map" role="list" aria-label={t.diagnoseStepOne}>
                  <i className="axis axis-x" />
                  <i className="axis axis-y" />
                  <span className="semantic-region region-visual">Visual cues</span>
                  <span className="semantic-region region-task">Task intent</span>
                  <span className="semantic-region region-loop">Loops</span>
                  <span className="semantic-region region-transition">State shifts</span>
                  {embeddingPoints.map((point) => (
                    <button
                      aria-label={point.label}
                      className={point.active ? "embedding-dot active" : "embedding-dot"}
                      key={point.taskId}
                      role="listitem"
                      style={{ left: `${point.x}%`, top: `${point.y}%` }}
                      title={`${point.label} · ${point.score.toFixed(1)}`}
                      type="button"
                      onBlur={() => setHoveredEmbeddingLabel("")}
                      onFocus={() => setHoveredEmbeddingLabel(point.label)}
                      onMouseEnter={() => setHoveredEmbeddingLabel(point.label)}
                      onMouseLeave={() => setHoveredEmbeddingLabel("")}
                      onClick={() => {
                        const task = diagnosticPool.find((candidate) => candidate.taskId === point.taskId);
                        if (task) void chooseTask(task);
                      }}
                    />
                  ))}
                </div>
                <div className={hoveredEmbeddingLabel ? "semantic-hover-preview visible" : "semantic-hover-preview"} aria-live="polite">
                  {hoveredEmbeddingLabel}
                </div>
              </section>

              <section className="diagnose-step action-step" aria-label={t.diagnoseStepTwo}>
                <div className="diagnose-step-heading action-heading">
                  <b>2</b>
                  <span>{t.diagnoseStepTwo}</span>
                </div>
                <div className="action-chip-cloud">
                  {actionChips.map((chip) => (
                    <button
                      className={`action-chip tone-${chip.tone} size-${chip.size} ${chip.active ? "active" : ""}`}
                      key={chip.term}
                      type="button"
                      onClick={() => handleActionTermSelect(chip.term)}
                    >
                      {chip.term}
                    </button>
                  ))}
                </div>
              </section>
            </div>
            <div className="diagnose-grid">
              <label className="field">
                <span>{t.diagnoseDimension}</span>
                <select value={diagnoseDimension} onChange={(event) => setDiagnoseDimension(event.currentTarget.value as AgentDiagnoseDimension)}>
                  {diagnoseDimensions.map((dimension) => (
                    <option key={dimension.value} value={dimension.value}>
                      {dimension.labels[language]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t.diagnoseMinScore}</span>
                <select value={diagnoseMinScore} onChange={(event) => setDiagnoseMinScore(event.currentTarget.value)}>
                  <option value="2">2+</option>
                  <option value="3">3+</option>
                  <option value="3.5">3.5+</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>{t.diagnosePattern}</span>
              <input value={diagnosePattern} onChange={(event) => setDiagnosePattern(event.currentTarget.value)} placeholder={t.diagnosePatternPlaceholder} />
            </label>
            <button className="secondary-button diagnose-apply" type="button" onClick={handleDiagnoseSearch}>
              {t.diagnoseApply}
            </button>
          </div>
          <div className="library-count-strip">
            <strong>{searchResults.length}</strong>
            <span>
              {language === "zh"
                ? `匹配任务 · 当前展示 ${Math.min(searchResults.length, visibleSearchResultLimit)}`
                : `matched tasks · showing ${Math.min(searchResults.length, visibleSearchResultLimit)}`}
            </span>
          </div>
          <div className="task-results" aria-live="polite">
            {searchResults.slice(0, visibleSearchResultLimit).map((task) => (
              <button
                className={task.taskId === selectedTask.taskId ? "task-result active" : "task-result"}
                key={task.taskId}
                type="button"
                title={`${taskSourceLabel(task)} · ${taskRunSummary(task, language)} · ${task.taskId}`}
                onClick={() => void chooseTask(task)}
              >
                <strong>{taskQuestion(task, 155)}</strong>
              </button>
            ))}
          </div>
          {searchResults.length > visibleSearchResultLimit ? (
            <p className="result-count-note">
              {language === "zh"
                ? `显示前 ${visibleSearchResultLimit} / ${searchResults.length} 个结果，继续输入关键词可缩小范围。`
                : `Showing first ${visibleSearchResultLimit} / ${searchResults.length} results. Keep typing to narrow.`}
            </p>
          ) : null}
        </section>
        ) : null}

        {activeSideTab === "cases" ? (
          <section className="tool-section cases-section">
            <div className="section-heading">
              <span>03</span>
              <h2>{t.researchCases}</h2>
            </div>
            {researchCases.length ? (
              <div className="research-cases standalone" aria-label={t.researchCases}>
                <div className="research-cases-heading">
                  <span>{t.researchCases}</span>
                  <b>{t.researchCasesHint}</b>
                </div>
                <div className="research-case-grid">
                  {researchCases.map((caseRow) => (
                    <button
                      className={caseRow.taskId === selectedTask.taskId && caseRow.runAId === traceA.traceId && caseRow.runBId === traceB.traceId ? "research-case active" : "research-case"}
                      key={`${caseRow.kind}-${caseRow.taskId}-${caseRow.runAId}-${caseRow.runBId}`}
                      title={researchCaseTitle(caseRow)}
                      type="button"
                      onClick={() => void chooseResearchCase(caseRow)}
                    >
                      <span>{caseRow.label}</span>
                      <strong>{researchCaseMetric(caseRow, language)}</strong>
                      <small>{shortText(caseRow.title, 64)}</small>
                      <em>{shortText(researchCaseInterpretation(caseRow, language), 118)}</em>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="status-line">{t.staticFailed}</p>
            )}
          </section>
        ) : null}
      </aside>
    </main>
  );
}

function SplitPathCanvas({ layout, language }: { layout: NonNullable<ReturnType<typeof buildSplitPathLayout>>; language: Language }) {
  const t = copy[language];
  const [preview, setPreview] = useState<{ node: CanvasNode; left: number; top: number } | null>(null);

  function showPreview(node: CanvasNode, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const width = Math.min(760, window.innerWidth - 32);
    const height = Math.min(680, window.innerHeight - 32);
    const preferRight = node.lane !== "b";
    const rawLeft = preferRight ? rect.right + 14 : rect.left - width - 14;
    const left = Math.max(16, Math.min(window.innerWidth - width - 16, rawLeft));
    const top = Math.max(16, Math.min(window.innerHeight - height - 16, rect.top - 84));
    setPreview({ node, left, top });
  }

  return (
    <div className="split-path-stage" style={{ width: layout.width, height: layout.height }}>
      <div className="arrow-legend" aria-label={t.arrowLegend}>
        <span>{t.arrowLegend}</span>
        <b className="legend-a">{t.laneLegendA}</b>
        <b className="legend-b">{t.laneLegendB}</b>
        <em>{t.dashedLegend}</em>
      </div>
      <svg className="path-lines" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        <defs>
          <marker id="arrow-a" markerHeight="8" markerWidth="9" orient="auto" refX="8" refY="4">
            <path d="M0,0 L0,8 L8,4 z" />
          </marker>
          <marker id="arrow-b" markerHeight="8" markerWidth="9" orient="auto" refX="8" refY="4">
            <path d="M0,0 L0,8 L8,4 z" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <line
            className={`path-line lane-${edge.lane} emphasis-${edge.emphasis}`}
            key={edge.id}
            markerEnd={`url(#arrow-${edge.lane})`}
            x1={edge.fromX}
            x2={edge.toX}
            y1={edge.fromY}
            y2={edge.toY}
          />
        ))}
      </svg>
      {layout.markers.map((marker) => (
        <div className={`event-marker ${marker.event}`} key={marker.id} style={{ left: marker.x, top: marker.y }}>
          <strong>{marker.label}</strong>
          <span>{scorePercent(marker.score)}</span>
        </div>
      ))}
      {layout.nodes.map((node) => (
        <PathCard key={node.id} language={language} node={node} onHidePreview={() => setPreview(null)} onShowPreview={showPreview} />
      ))}
      {preview ? <FloatingNodePreview language={language} left={preview.left} node={preview.node} top={preview.top} /> : null}
    </div>
  );
}

function PathCard({
  node,
  language,
  onHidePreview,
  onShowPreview,
}: {
  node: CanvasNode;
  language: Language;
  onHidePreview: () => void;
  onShowPreview: (node: CanvasNode, element: HTMLElement) => void;
}) {
  const isTask = node.lane === "task";
  const isMissing = node.title.toLowerCase().includes("missing") || node.actionLabel.toLowerCase().includes("missing");
  const isFailure = /failure|early stop|unable to|same action|agent failure/i.test(
    [node.title, node.actionLabel, node.detailTitle, node.agentNote, node.agentNoteB].filter(Boolean).join(" "),
  );
  return (
    <article
      className={`path-card lane-${node.lane} event-${node.event} ${isMissing ? "is-missing" : ""} ${isFailure ? "is-failure" : ""}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
      }}
      tabIndex={0}
      aria-label={`${node.actionLabel}. ${node.detailTitle}`}
      onBlur={onHidePreview}
      onFocus={(event) => onShowPreview(node, event.currentTarget)}
      onMouseEnter={(event) => onShowPreview(node, event.currentTarget)}
      onMouseLeave={onHidePreview}
    >
      <div className="path-card-top">
        <span>{eventLabel(node.event, language)}</span>
        {node.lane !== "task" ? <b>{scorePercent(node.score)}</b> : null}
      </div>
      <h3>{isTask ? node.title : node.actionLabel}</h3>
      {isTask ? <p>{shortText(node.body, 110)}</p> : null}
    </article>
  );
}

function FloatingNodePreview({ node, language, left, top }: { node: CanvasNode; language: Language; left: number; top: number }) {
  const imageA = displayableImageRef(node.imageA);
  const imageB = displayableImageRef(node.imageB);
  const hasFrameA = Boolean(node.imageA);
  const hasFrameB = Boolean(node.imageB);
  const t = copy[language];
  const frameLabel = t.frameAvailable;
  const frameCount = Number(Boolean(imageA || hasFrameA)) + Number(Boolean(imageB || hasFrameB));
  return (
    <div className="node-popover floating-preview" role="tooltip" style={{ left, top }}>
      <div className="node-popover-header">
        <strong>{node.detailTitle}</strong>
        <span>{node.lane === "task" ? node.meta : node.metaB ? `${node.meta} + ${node.metaB}` : node.meta}</span>
      </div>
      {(hasFrameA || hasFrameB) && (
        <div className={`popover-frames frame-count-${frameCount}`} aria-label={t.frames}>
          {imageA ? (
            <a className="popover-frame frame-a" href={imageA} target="_blank" rel="noreferrer" title={node.imageAltA}>
              <img src={imageA} alt={node.imageAltA ?? "Run A visual frame"} decoding="async" loading="eager" />
              <span>Run A</span>
            </a>
          ) : hasFrameA ? (
            <span className="popover-frame frame-placeholder frame-a" title={node.imageA}>
              {frameLabel}
            </span>
          ) : null}
          {imageB ? (
            <a className="popover-frame frame-b" href={imageB} target="_blank" rel="noreferrer" title={node.imageAltB}>
              <img src={imageB} alt={node.imageAltB ?? "Run B visual frame"} decoding="async" loading="eager" />
              <span>Run B</span>
            </a>
          ) : hasFrameB ? (
            <span className="popover-frame frame-placeholder frame-b" title={node.imageB}>
              {frameLabel}
            </span>
          ) : null}
        </div>
      )}
      <dl>
        <div>
          <dt>{t.target}</dt>
          <dd>{node.detailTitle}</dd>
        </div>
        <div>
          <dt>{t.agentOutput}</dt>
          <dd>{node.agentNote ?? (node.metaB ? `${node.meta} + ${node.metaB}` : node.meta)}</dd>
        </div>
        {node.agentNoteB && node.agentNoteB !== node.agentNote ? (
          <div>
            <dt>Run B output</dt>
            <dd>{node.agentNoteB}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function filterTasks(tasks: GuiAgentTask[], query: string): GuiAgentTask[] {
  const comparableTasks = tasks.filter(isComparableTask);
  if (!query) return comparableTasks;
  return comparableTasks.filter((task) => {
    const haystack = [
      task.taskId,
      task.taskNumericId ?? "",
      task.title,
      task.domain,
      task.instruction,
      task.startUrl,
      task.benchmark ?? "",
      task.site ?? "",
      task.sourceCollection ?? "",
      task.sourcePath ?? "",
      ...(task.sourceFiles ?? []),
      task.riskTags.join(" "),
      ...task.traces.map(
        (trace) =>
          `${trace.traceId} ${trace.taskId} ${trace.modelId} ${trace.sourceLabel ?? ""} ${trace.site ?? ""} ${trace.outcome ?? ""}`,
      ),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export default App;
