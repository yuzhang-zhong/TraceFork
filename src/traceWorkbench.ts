import { parseNormalizedTraceImport } from "./trajectoryImport.js";
import type {
  GuiAgentActionType,
  GuiAgentTask,
  GuiAgentTrace,
  GuiAgentTraceStep,
  GuiTraceAnalysis,
  GuiTraceSourceType,
} from "./projectTypes.js";

export type LlmProvider = "openai" | "gemini";

export type ParsedPasteResult =
  | {
      ok: true;
      mode: "task_bundle";
      tasks: GuiAgentTask[];
      warnings: string[];
    }
  | {
      ok: true;
      mode: "single_trace";
      trace: GuiAgentTrace;
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
      warnings: string[];
    };

export type CanvasNode = {
  id: string;
  lane: "task" | "a" | "b" | "shared";
  stepIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  event: GuiTraceAnalysis["comparisons"][number]["event"] | "task";
  title: string;
  actionLabel: string;
  detailTitle: string;
  meta: string;
  metaB?: string;
  body: string;
  bodyB?: string;
  url?: string;
  agentNote?: string;
  agentNoteB?: string;
  imageA?: string;
  imageB?: string;
  imageAltA?: string;
  imageAltB?: string;
};

export type CanvasEdge = {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  lane: "a" | "b";
  emphasis: "root" | "stable" | "diverged" | "converging" | "rejoined" | "missing";
};

export type CanvasMarker = {
  id: string;
  x: number;
  y: number;
  label: string;
  score: number;
  event: GuiTraceAnalysis["comparisons"][number]["event"];
};

export type SplitPathLayout = {
  width: number;
  height: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  markers: CanvasMarker[];
};

const defaultScreenshotSize = { width: 1280, height: 820 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothStep(value: number): number {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function visualRef(step: GuiAgentTraceStep | null | undefined): string | undefined {
  return step?.thumbnailRef ?? step?.screenshotRef;
}

function isDisplayableFrameRef(value: string | undefined): boolean {
  return Boolean(value && /^(data:image\/|https?:\/\/|\/)/i.test(value));
}

function normalizeFrameRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return undefined;
  if (/^(data:image\/|https?:\/\/|\/|embedded:|zip:)/i.test(trimmed)) return trimmed;
  return undefined;
}

function extractImageRefs(value: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /!\[[^\]]*]\(([^)\s]+)\)/gi,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    /\b(?:image|img|screenshot|frame|thumbnail|visual)\s*[:=]\s*(data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+|https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)/gi,
    /\b(data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\b/gi,
    /\b(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?)\b/gi,
  ];
  patterns.forEach((pattern) => {
    for (const match of value.matchAll(pattern)) {
      const ref = normalizeFrameRef(match[1] ?? match[0]);
      if (ref) refs.add(ref);
    }
  });
  return [...refs];
}

function isFailureStepForDisplay(step: GuiAgentTraceStep | null | undefined): boolean {
  if (!step) return false;
  const text = [step.actionType, step.target.label, step.structuredRationale, step.agentOutputExcerpt, step.stateAfter]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(early stop|same action|unable to|cannot|can not|could not|failed|failure|no matching|not found|do not have the ability)\b/.test(text);
}

function actionLabel(step: GuiAgentTraceStep | null | undefined, fallbackIndex: number, markFailure = false): string {
  if (!step) return `${fallbackIndex}. missing`;
  if (markFailure && isFailureStepForDisplay(step)) return `${fallbackIndex}. failure`;
  return `${fallbackIndex}. ${step.actionType}`;
}

function pairedActionLabel(
  stepA: GuiAgentTraceStep | null | undefined,
  stepB: GuiAgentTraceStep | null | undefined,
  fallbackIndex: number,
): string {
  if (!stepA && !stepB) return `${fallbackIndex}. missing`;
  if (!stepA || !stepB) return actionLabel(stepA ?? stepB, fallbackIndex);
  if (stepA.actionType === stepB.actionType) return `${fallbackIndex}. ${stepA.actionType}`;
  const compactAction = (action: GuiAgentActionType) => (action === "navigate" ? "nav" : action);
  const action = stepA.actionType === stepB.actionType ? compactAction(stepA.actionType) : `${compactAction(stepA.actionType)}+${compactAction(stepB.actionType)}`;
  return `${fallbackIndex}. ${action}`;
}

function stepTitle(step: GuiAgentTraceStep | null | undefined, fallbackIndex: number, markFailure = false): string {
  if (!step) return `${fallbackIndex}. missing step`;
  const rawStep = step.stepIndex !== fallbackIndex ? ` / raw step ${step.stepIndex}` : "";
  if (markFailure && isFailureStepForDisplay(step)) return `${fallbackIndex}. agent failure / stop${rawStep}`;
  return `${fallbackIndex}. ${step.actionType} ${shortText(step.target.label, 38)}${rawStep}`;
}

function pairedStepTitle(
  stepA: GuiAgentTraceStep | null | undefined,
  stepB: GuiAgentTraceStep | null | undefined,
  fallbackIndex: number,
): string {
  if (!stepA && !stepB) return `${fallbackIndex}. missing step`;
  if (!stepA || !stepB) return stepTitle(stepA ?? stepB, fallbackIndex);
  if (stepA.stepIndex === stepB.stepIndex && stepA.actionType === stepB.actionType) return stepTitle(stepA, fallbackIndex);
  return `${fallbackIndex}. A raw ${stepA.stepIndex}: ${stepA.actionType} ${shortText(stepA.target.label, 30)} / B raw ${stepB.stepIndex}: ${stepB.actionType} ${shortText(stepB.target.label, 30)}`;
}

export function shortText(value: string | undefined, max = 96): string {
  const normalized = (value ?? "")
    .replace(/^url:/, "")
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?[^\s"'<>]*/gi, "[local url removed]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[web page]")
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/gi, "[local host]")
    .replace(/(^|[\s"'(])[a-z]:[\\/][^\s"'<>]+/gi, "$1[local path removed]")
    .replace(/\b(?:file|embedded|zip):[^\s"'<>]+/gi, "[source ref]")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "No observable summary";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function displayNote(step: GuiAgentTraceStep | null | undefined): string | undefined {
  if (!step) return undefined;
  return shortText(step.agentOutputExcerpt ?? step.structuredRationale, 220);
}

function sanitizeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/https?:\/\//g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "pasted-trajectory"
  );
}

function parseActionType(value: string): GuiAgentActionType {
  const normalized = value.toLowerCase();
  if (normalized.includes("click") || normalized.includes("tap")) return "click";
  if (normalized.includes("type") || normalized.includes("fill") || normalized.includes("input") || normalized.includes("press")) return "type";
  if (normalized.includes("scroll")) return "scroll";
  if (normalized.includes("select") || normalized.includes("choose")) return "select";
  if (normalized.includes("goto") || normalized.includes("navigate") || normalized.includes("open")) return "navigate";
  if (normalized.includes("wait")) return "wait";
  return "click";
}

function normalizedSingleTraceCandidate(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  if (isRecord(record.trace)) return { ...record.trace, task: record.task };
  if (Array.isArray(record.traces) && isRecord(record.traces[0])) return record.traces[0];
  if (isRecord(record.result)) return normalizedSingleTraceCandidate(record.result);
  return record;
}

function firstStringFromRecord(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function fallbackBbox(stepIndex: number): [number, number, number, number] {
  return [64 + ((stepIndex - 1) % 4) * 112, 88 + Math.floor((stepIndex - 1) / 4) * 76, 96, 38];
}

function extractUrl(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
}

function extractTargetLabel(value: string, stepIndex: number): string {
  const quoted = value.match(/["']([^"']{2,90})["']/);
  if (quoted?.[1]) return quoted[1];
  const bracket = value.match(/\[([^\]]{2,90})\]/);
  if (bracket?.[1]) return bracket[1];
  const target = value.match(/(?:target|selector|element|button|link|field)\s*[:=]\s*([^,;]{2,90})/i);
  if (target?.[1]) return target[1].trim();
  return `observable target ${stepIndex}`;
}

function extractInputText(value: string): string | undefined {
  return value.match(/(?:type|fill|input|press)[^"']*["']([^"']{1,120})["']/i)?.[1];
}

function lineToStep(line: string, index: number, frameRef?: string): GuiAgentTraceStep {
  const stepIndex = index + 1;
  const actionType = parseActionType(line);
  const url = extractUrl(line);
  const targetLabel = extractTargetLabel(line, stepIndex);
  const imageRefs = extractImageRefs(line);
  const imageRef = normalizeFrameRef(frameRef) ?? imageRefs[0];
  const displayableImageRef = isDisplayableFrameRef(imageRef) ? imageRef : undefined;
  return {
    stepIndex,
    observationType: imageRef ? "mixed" : url ? "mixed" : "dom",
    observationSummary: shortText(line, 160),
    actionType,
    target: {
      label: targetLabel,
      bbox: fallbackBbox(stepIndex),
    },
    inputText: extractInputText(line),
    structuredRationale: "Observable pasted trajectory action parsed without private reasoning analysis.",
    confidence: 0.5,
    stateAfter: url ? `url:${url}` : `${sanitizeId(targetLabel)}:${actionType}:${stepIndex}`,
    url,
    screenshotRef: imageRef,
    thumbnailRef: displayableImageRef,
    visualFrameAvailable: Boolean(imageRef),
    sourceRef: `paste#line-${stepIndex}`,
    adapterConfidence: "medium",
    sourceWarnings: ["parsed from pasted text; semantic target confidence is estimated"],
  };
}

export function buildSingleTraceFromPastedText(rawText: string, task: GuiAgentTask, modelId = "pasted-run"): GuiAgentTrace | null {
  const rawLines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const pendingFrames: string[] = [];
  const steps: GuiAgentTraceStep[] = [];
  rawLines.forEach((line) => {
    const imageRefs = extractImageRefs(line);
    const isAction = /click|tap|type|fill|input|press|scroll|select|choose|goto|navigate|open|wait/i.test(line);
    if (!isAction) {
      pendingFrames.push(...imageRefs);
      return;
    }
    const inlineFrame = imageRefs[0];
    const frameRef = inlineFrame ?? pendingFrames.shift();
    steps.push(lineToStep(line, steps.length, frameRef));
  });

  if (steps.length === 0) {
    pendingFrames.push(...extractImageRefs(rawText));
    const uniqueFrames = [...new Set(pendingFrames)];
    if (uniqueFrames.length === 0) return null;
    uniqueFrames.slice(0, 80).forEach((frame, index) => {
      steps.push(
        lineToStep(
          `${index + 1}. wait [visual frame ${index + 1}] image: ${frame}`,
          index,
          frame,
        ),
      );
    });
  } else {
    pendingFrames.forEach((frame, index) => {
      const targetStep = steps.find((step) => !step.thumbnailRef && !step.screenshotRef) ?? steps[Math.min(index, steps.length - 1)];
      if (!targetStep) return;
      const normalized = normalizeFrameRef(frame);
      targetStep.screenshotRef = normalized;
      targetStep.thumbnailRef = isDisplayableFrameRef(normalized) ? normalized : undefined;
      targetStep.visualFrameAvailable = Boolean(normalized);
      targetStep.observationType = "mixed";
    });
  }
  const traceId = `${sanitizeId(task.taskId)}-${sanitizeId(modelId)}-${Date.now().toString(36)}`;
  return {
    traceId,
    agentId: sanitizeId(modelId),
    agentKind: "offline_run",
    modelId,
    taskId: task.taskId,
    steps: steps.slice(0, 80),
    sourceType: "normalized_json",
    sourceLabel: "Pasted trajectory",
    sourceWarnings: [
      "Pasted text parser used observable actions only.",
      ...(steps.some((step) => step.visualFrameAvailable) ? ["Pasted visual frame refs were attached to trajectory steps."] : []),
    ],
  };
}

export function parsePastedTrajectory(rawText: string, task: GuiAgentTask, modelId = "pasted-run"): ParsedPasteResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { ok: false, errors: ["Paste a trajectory log or normalized JSON first."], warnings: [] };
  }

  try {
    const json = JSON.parse(trimmed);
    const imported = parseNormalizedTraceImport(json);
    if (imported.ok) {
      return { ok: true, mode: "task_bundle", tasks: imported.tasks, warnings: imported.warnings };
    }
    const candidate = normalizedSingleTraceCandidate(json);
    const steps = Array.isArray(candidate.steps) ? candidate.steps : [];
    if (steps.length > 0) {
      const trace: GuiAgentTrace = {
        traceId: asString(candidate.traceId) ?? `${sanitizeId(task.taskId)}-${sanitizeId(modelId)}-${Date.now().toString(36)}`,
        agentId: asString(candidate.agentId) ?? sanitizeId(modelId),
        agentKind: "offline_run",
        modelId: asString(candidate.modelId) ?? modelId,
        taskId: task.taskId,
        steps: steps.map((step, index) => {
          const record = isRecord(step) ? step : {};
          const target = isRecord(record.target) ? record.target : {};
          const stepIndex = asNumber(record.stepIndex) ?? index + 1;
          const imageRef =
            firstStringFromRecord(record, ["thumbnailRef", "thumbnail_ref", "screenshotRef", "screenshot_ref", "image", "imageUrl", "image_url", "frame", "frameUrl"]) ??
            extractImageRefs(JSON.stringify(record))[0];
          const normalizedImageRef = normalizeFrameRef(imageRef);
          return {
            stepIndex,
            observationType: record.observationType === "dom" || record.observationType === "screenshot" ? record.observationType : "mixed",
            observationSummary: asString(record.observationSummary) ?? "Pasted normalized step.",
            actionType: parseActionType(asString(record.actionType) ?? "click"),
            target: {
              label: asString(target.label) ?? `pasted target ${stepIndex}`,
              domSelector: asString(target.domSelector) ?? undefined,
              bbox: Array.isArray(target.bbox) && target.bbox.length === 4 ? (target.bbox.map(Number) as [number, number, number, number]) : fallbackBbox(stepIndex),
            },
            inputText: asString(record.inputText) ?? undefined,
            structuredRationale: "Observable pasted normalized action step.",
            agentOutputExcerpt: shortText(asString(record.agentOutputExcerpt) ?? asString(record.structuredRationale) ?? undefined, 220),
            confidence: asNumber(record.confidence) ?? 0.55,
            stateAfter: asString(record.stateAfter) ?? `pasted_step_${stepIndex}`,
            url: asString(record.url) ?? undefined,
            sourceRef: asString(record.sourceRef) ?? `paste#step-${stepIndex}`,
            screenshotRef: normalizedImageRef ?? undefined,
            thumbnailRef: isDisplayableFrameRef(normalizedImageRef) ? normalizedImageRef : undefined,
            visualFingerprint: asString(record.visualFingerprint) ?? undefined,
            adapterConfidence: record.adapterConfidence === "high" || record.adapterConfidence === "low" ? record.adapterConfidence : "medium",
            visualFrameAvailable: typeof record.visualFrameAvailable === "boolean" ? record.visualFrameAvailable : Boolean(normalizedImageRef),
          };
        }),
        sourceType: "normalized_json",
        sourceLabel: "Pasted normalized trace",
      };
      return { ok: true, mode: "single_trace", trace, warnings: imported.ok ? [] : imported.warnings };
    }
  } catch {
    // Fall through to line parser.
  }

  const trace = buildSingleTraceFromPastedText(trimmed, task, modelId);
  if (!trace) {
    return {
      ok: false,
      errors: ["Could not find observable click/type/scroll/select/navigate/wait actions in the pasted text."],
      warnings: [],
    };
  }
  return { ok: true, mode: "single_trace", trace, warnings: trace.sourceWarnings ?? [] };
}

export function mergeTasks(existingTasks: GuiAgentTask[], incomingTasks: GuiAgentTask[]): GuiAgentTask[] {
  const merged = new Map(existingTasks.map((task) => [task.taskId, task]));
  incomingTasks.forEach((task) => {
    const current = merged.get(task.taskId);
    if (!current) {
      merged.set(task.taskId, task);
      return;
    }
    const traces = new Map(current.traces.map((trace) => [trace.traceId, trace]));
    task.traces.forEach((trace) => {
      const existingTrace = traces.get(trace.traceId);
      if (existingTrace && existingTrace.steps.length > 0 && trace.steps.length === 0) {
        return;
      }
      traces.set(trace.traceId, trace);
    });
    merged.set(task.taskId, { ...current, ...task, traces: [...traces.values()] });
  });
  return [...merged.values()];
}

export function appendTraceToTask(tasks: GuiAgentTask[], taskId: string, trace: GuiAgentTrace): GuiAgentTask[] {
  return tasks.map((task) =>
    task.taskId === taskId
      ? {
          ...task,
          traces: [...task.traces.filter((candidate) => candidate.traceId !== trace.traceId), { ...trace, taskId }],
          sourceType: task.sourceType ?? ("normalized_json" satisfies GuiTraceSourceType),
        }
      : task,
  );
}

export function buildSplitPathLayout(task: GuiAgentTask, traceA: GuiAgentTrace, traceB: GuiAgentTrace, analysis: GuiTraceAnalysis): SplitPathLayout {
  const width = 820;
  const centerX = width / 2;
  const canvasMargin = 28;
  const taskNode: CanvasNode = {
    id: "task-root",
    lane: "task",
    stepIndex: 0,
    x: centerX,
    y: 136,
    width: 430,
    height: 116,
    score: 0,
    event: "task",
    title: task.title,
    actionLabel: "Task",
    detailTitle: task.title,
    meta: task.domain,
    body: task.instruction,
    url: task.startUrl,
  };

  const nodes: CanvasNode[] = [taskNode];
  const markers: CanvasMarker[] = [];
  const cardWidth = 198;
  const cardHeight = 68;
  const maxExtraOffset = 152;
  const minSplitOffset = (cardWidth + 54) / 2;
  let driftA = 0;
  let driftB = 0;
  let pairCenterDrift = 0;

  function geometryScore(comparison: GuiTraceAnalysis["comparisons"][number]): number {
    if (!comparison.textStep || !comparison.visionStep) return 1;
    return clamp(
      comparison.actionTypeDiff * 0.34 +
        comparison.targetElementDiff * 0.28 +
        comparison.stateSemanticDistance * 0.28 +
        comparison.screenRegionDistance * 0.1,
      0,
      1,
    );
  }

  function markerLabel(comparison: GuiTraceAnalysis["comparisons"][number]): string {
    if (comparison.divergenceType === "agent_failure") {
      return "failure / stop";
    }
    if (!comparison.textStep || !comparison.visionStep) return "missing counterpart";
    const parts = [
      comparison.actionTypeDiff ? "action" : "",
      comparison.targetElementDiff >= 0.5 ? "target" : "",
      comparison.stateSemanticDistance >= 0.26 ? "state" : "",
      comparison.screenRegionDistance >= 0.35 ? "screen" : "",
    ].filter(Boolean);
    if (comparison.event === "rejoined") return "rejoin";
    if (comparison.event === "converging") return "converging";
    return parts.length ? parts.join(" + ") : comparison.label;
  }

  function offsetFor(comparison: GuiTraceAnalysis["comparisons"][number]): number {
    const geometric = geometryScore(comparison);
    if (comparison.event === "rejoined") return 0;
    if (comparison.event === "stable" && (comparison.contextSimilarity ?? 0) >= 0.64 && geometric < 0.26) return 0;
    if (comparison.event === "stable" && geometric < 0.18) return 0;
    const score = smoothStep(geometric);
    const rawOffset = 46 + score * maxExtraOffset;
    if (comparison.event === "converging") return clamp(rawOffset * 0.54, 34, 154);
    return clamp(rawOffset, 72, 248);
  }

  function lanePositions(comparison: GuiTraceAnalysis["comparisons"][number], laneOffset: number): { a: number; b: number; yA: number; yB: number } {
    if (laneOffset === 0) {
      driftA *= 0.28;
      driftB *= 0.28;
      pairCenterDrift *= 0.32;
      return { a: centerX + pairCenterDrift, b: centerX + pairCenterDrift, yA: 0, yB: 0 };
    }
    const textMissing = !comparison.textStep;
    const visionMissing = !comparison.visionStep;
    const geometric = geometryScore(comparison);
    const actionPull = comparison.actionTypeDiff * 58;
    const targetPull = comparison.targetElementDiff * 48;
    const regionPull = comparison.screenRegionDistance * 30;
    const statePull = comparison.stateSemanticDistance * 58;
    const asymmetricPull = actionPull + targetPull + regionPull + statePull;
    const scorePull = smoothStep(geometric) * 58;
    const missingPull = textMissing || visionMissing ? 34 : 0;
    const signature = [
      comparison.textStep?.actionType,
      comparison.textStep?.target.label,
      comparison.textStep?.stateAfter,
      comparison.visionStep?.actionType,
      comparison.visionStep?.target.label,
      comparison.visionStep?.stateAfter,
    ].join("|");
    const hash = stableHash(`${comparison.stepIndex}:${signature}`);
    const contentDirection = ((hash % 2001) / 1000 - 1) * 28;
    const contentBalance = (((hash >>> 11) % 2001) / 1000 - 1) * 22;
    const stepBias = comparison.stepIndex % 3 === 0 ? -14 : comparison.stepIndex % 3 === 1 ? 9 : 3;
    const aDelta = (textMissing ? missingPull : asymmetricPull * 0.28 + scorePull * 0.18) + contentBalance * 0.35;
    const bDelta = (visionMissing ? missingPull : asymmetricPull * 0.58 + scorePull * 0.36) - contentBalance * 0.25;
    driftA = clamp(driftA * 0.46 + aDelta, -34, 94);
    driftB = clamp(driftB * 0.52 + bDelta, -24, 116);
    pairCenterDrift = clamp(pairCenterDrift * 0.64 + contentDirection + stepBias, -46, 46);
    if (comparison.event === "converging") {
      driftA *= 0.62;
      driftB *= 0.62;
      pairCenterDrift *= 0.58;
    }
    const leftOffset = clamp(laneOffset * (0.76 + (hash % 7) * 0.028) + driftA, minSplitOffset, 238);
    const rightOffset = clamp(laneOffset * (0.7 + ((hash >>> 7) % 9) * 0.03) + driftB, minSplitOffset, 248);
    const ySkew = clamp((contentBalance + actionPull * 0.12 - statePull * 0.1) * 0.32, -8, 8);
    return {
      a: clamp(centerX + pairCenterDrift - leftOffset, cardWidth / 2 + canvasMargin, width - cardWidth / 2 - canvasMargin),
      b: clamp(centerX + pairCenterDrift + rightOffset, cardWidth / 2 + canvasMargin, width - cardWidth / 2 - canvasMargin),
      yA: ySkew,
      yB: -ySkew * 0.74,
    };
  }

  function travelAfter(comparison: GuiTraceAnalysis["comparisons"][number]): number {
    const score = smoothStep(geometryScore(comparison));
    if (!comparison.textStep || !comparison.visionStep) return clamp(130 + score * 36, 130, 178);
    if (comparison.event === "rejoined") return 124;
    if (comparison.event === "converging") return 132;
    if (comparison.event === "persistent_divergence") return clamp(154 + score * 58, 154, 212);
    if (comparison.event === "diverged") return clamp(148 + score * 52, 148, 198);
    return clamp(128 + score * 14, 128, 146);
  }

  function edgeBetween(from: CanvasNode, to: CanvasNode, lane: "a" | "b", emphasis: CanvasEdge["emphasis"]): CanvasEdge {
    const dx = to.x - from.x;
    const fromInset = clamp(dx * 0.22, -from.width / 2 + 22, from.width / 2 - 22);
    const toInset = clamp(-dx * 0.22, -to.width / 2 + 22, to.width / 2 - 22);
    const sharedShift = lane === "a" ? -4 : 4;
    const fromSharedShift = from.lane === "shared" || from.lane === "task" ? sharedShift : 0;
    const toSharedShift = to.lane === "shared" || to.lane === "task" ? sharedShift : 0;
    const rawFromX = from.x + fromInset + fromSharedShift;
    const rawToX = to.x + toInset + toSharedShift;
    return {
      id: `${from.id}-${to.id}`,
      lane,
      emphasis,
      fromX: clamp(rawFromX, canvasMargin, width - canvasMargin),
      fromY: from.y + from.height / 2,
      toX: clamp(rawToX, canvasMargin, width - canvasMargin),
      toY: to.y - to.height / 2,
    };
  }

  let currentY = taskNode.y + taskNode.height + 132;
  analysis.comparisons.forEach((comparison) => {
    const score = comparison.divergenceScore;
    const laneOffset = offsetFor(comparison);
    const positions = lanePositions(comparison, laneOffset);
    const y = currentY;
    const textStep = comparison.textStep;
    const visionStep = comparison.visionStep;
    const markFailure = comparison.divergenceType === "agent_failure" && comparison.event !== "rejoined";

    if (laneOffset === 0) {
      nodes.push({
        id: `shared-${comparison.stepIndex}`,
        lane: "shared",
        stepIndex: comparison.stepIndex,
        x: centerX,
        y,
        width: 286,
        height: cardHeight,
        score,
        event: comparison.event,
        title: stepTitle(textStep ?? visionStep, comparison.stepIndex, markFailure),
        actionLabel: pairedActionLabel(textStep, visionStep, comparison.stepIndex),
        detailTitle: markFailure ? stepTitle(textStep ?? visionStep, comparison.stepIndex, true) : pairedStepTitle(textStep, visionStep, comparison.stepIndex),
        meta: traceA.modelId,
        metaB: traceB.modelId,
        body: shortText(textStep?.observationSummary ?? textStep?.stateAfter, 76),
        bodyB: shortText(visionStep?.observationSummary ?? visionStep?.stateAfter, 76),
        url: textStep?.url ?? visionStep?.url,
        agentNote: displayNote(textStep),
        agentNoteB: displayNote(visionStep),
        imageA: visualRef(textStep),
        imageB: visualRef(visionStep),
        imageAltA: textStep ? `${traceA.modelId} step ${textStep.stepIndex}` : undefined,
        imageAltB: visionStep ? `${traceB.modelId} step ${visionStep.stepIndex}` : undefined,
      });
    } else {
      nodes.push({
        id: `a-${comparison.stepIndex}`,
        lane: "a",
        stepIndex: comparison.stepIndex,
        x: positions.a,
        y: y + positions.yA,
        width: cardWidth,
        height: cardHeight,
        score,
        event: comparison.event,
        title: stepTitle(textStep, comparison.stepIndex, markFailure),
        actionLabel: actionLabel(textStep, comparison.stepIndex, markFailure),
        detailTitle: stepTitle(textStep, comparison.stepIndex, markFailure),
        meta: traceA.modelId,
        body: shortText(textStep?.observationSummary ?? textStep?.stateAfter, 92),
        url: textStep?.url,
        agentNote: displayNote(textStep),
        imageA: visualRef(textStep),
        imageAltA: textStep ? `${traceA.modelId} step ${textStep.stepIndex}` : undefined,
      });
      nodes.push({
        id: `b-${comparison.stepIndex}`,
        lane: "b",
        stepIndex: comparison.stepIndex,
        x: positions.b,
        y: y + positions.yB,
        width: cardWidth,
        height: cardHeight,
        score,
        event: comparison.event,
        title: stepTitle(visionStep, comparison.stepIndex, markFailure),
        actionLabel: actionLabel(visionStep, comparison.stepIndex, markFailure),
        detailTitle: stepTitle(visionStep, comparison.stepIndex, markFailure),
        meta: traceB.modelId,
        body: shortText(visionStep?.observationSummary ?? visionStep?.stateAfter, 92),
        url: visionStep?.url,
        agentNote: displayNote(visionStep),
        imageB: visualRef(visionStep),
        imageAltB: visionStep ? `${traceB.modelId} step ${visionStep.stepIndex}` : undefined,
      });
    }
    if (comparison.event !== "stable") {
      markers.push({
        id: `marker-${comparison.stepIndex}`,
        x: centerX,
        y: laneOffset === 0 ? y + cardHeight / 2 + 28 : y,
        label: markerLabel(comparison),
        score: comparison.divergenceScore,
        event: comparison.event,
      });
    }
    currentY += travelAfter(comparison);
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: CanvasEdge[] = [];
  function nodeFor(lane: "a" | "b", stepIndex: number): CanvasNode | undefined {
    return nodeById.get(`${lane}-${stepIndex}`) ?? nodeById.get(`shared-${stepIndex}`);
  }
  const first = analysis.comparisons[0];
  if (first) {
    (["a", "b"] as const).forEach((lane) => {
      const to = nodeFor(lane, first.stepIndex);
      if (!to) return;
      const missing = lane === "a" ? !first.textStep : !first.visionStep;
      edges.push(edgeBetween(taskNode, to, lane, missing ? "missing" : "root"));
    });
  }
  analysis.comparisons.slice(0, -1).forEach((comparison, index) => {
    const next = analysis.comparisons[index + 1];
    (["a", "b"] as const).forEach((lane) => {
      const from = nodeFor(lane, comparison.stepIndex);
      const to = nodeFor(lane, next.stepIndex);
      if (!from || !to) return;
      const missing = lane === "a" ? !next.textStep : !next.visionStep;
      edges.push(edgeBetween(from, to, lane, missing ? "missing" : next.event === "persistent_divergence" ? "diverged" : next.event));
    });
  });

  const height = Math.max(720, currentY + 160);
  return { width, height, nodes, edges, markers };
}

export function makeFallbackTaskFromTrace(trace: GuiAgentTrace, title = "Pasted trajectory task"): GuiAgentTask {
  return {
    taskId: trace.taskId,
    title,
    instruction: "Inspect an imported pasted trajectory.",
    domain: "Pasted trajectory",
    startUrl: trace.steps.find((step) => step.url)?.url ?? "offline://pasted-trajectory",
    successCriteria: "Compare observable trajectory actions and states.",
    riskTags: ["pasted", "offline"],
    textState: "Pasted observable actions are available.",
    visualState: "Screenshots may be absent unless supplied in normalized JSON.",
    screenshotSize: defaultScreenshotSize,
    traces: [trace],
    sourceType: "normalized_json",
    sourceLabel: "Pasted trajectory",
  };
}
