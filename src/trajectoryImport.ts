import JSZip from "jszip";
import type {
  GuiAgentActionType,
  GuiAgentKind,
  GuiAgentTask,
  GuiAgentTrace,
  GuiAgentTraceStep,
  GuiTraceAdapterAudit,
  GuiTraceImportResult,
  GuiTraceSourceType,
} from "./projectTypes.js";

type FileLike = {
  name: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type ZipTextFile = {
  path: string;
  text: string;
};

type HumanActionCandidate = {
  method: string;
  url: string | null;
  x: number | null;
  y: number | null;
  selector: string | null;
  text: string | null;
  raw: string;
};

const defaultScreenshotSize = { width: 1280, height: 820 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function publicExcerpt(value: string | undefined, max = 320): string | undefined {
  const normalized = (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?[^\s"'<>]*/gi, "[local url removed]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[web page]")
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/gi, "[local host]")
    .replace(/(^|[\s"'(])[a-z]:[\\/][^\s"'<>]+/gi, "$1[local path removed]")
    .replace(/\b(?:file|embedded|zip):[^\s"'<>]+/gi, "[source ref]");
  return normalized || undefined;
}

function parseAgentKind(value: unknown, fallback: GuiAgentKind = "offline_run"): GuiAgentKind {
  return value === "text_dom" || value === "vision_gui" || value === "human" || value === "offline_run"
    ? value
    : fallback;
}

function parseObservationType(value: unknown): GuiAgentTraceStep["observationType"] {
  return value === "dom" || value === "screenshot" || value === "mixed" ? value : "mixed";
}

function parseActionType(value: unknown): GuiAgentActionType | null {
  if (value === "click" || value === "type" || value === "scroll" || value === "select" || value === "wait" || value === "navigate") {
    return value;
  }
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("click")) return "click";
  if (normalized.includes("fill") || normalized.includes("type") || normalized.includes("press")) return "type";
  if (normalized.includes("scroll")) return "scroll";
  if (normalized.includes("select")) return "select";
  if (normalized.includes("goto") || normalized.includes("navigate") || normalized.includes("open")) return "navigate";
  if (normalized.includes("wait")) return "wait";
  return null;
}

function parseBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  return [value[0], value[1], value[2], value[3]];
}

function fallbackBbox(stepIndex: number): [number, number, number, number] {
  return [64 + ((stepIndex - 1) % 5) * 96, 72 + Math.floor((stepIndex - 1) / 5) * 72, 88, 36];
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function extractClassText(html: string, className: string): string[] {
  const pattern = new RegExp(`<[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "gi");
  return [...html.matchAll(pattern)]
    .map((match) => stripHtml(match[1] ?? ""))
    .filter((value) => value.length > 0);
}

function extractScreenshotRefs(html: string): string[] {
  const refs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => decodeHtml(match[1] ?? ""));
  return refs.filter((ref) => ref.length > 0);
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "imported-trace";
}

function actionLabel(actionText: string, stepIndex: number): string {
  const quoted = actionText.match(/["']([^"']{2,80})["']/);
  if (quoted?.[1]) return quoted[1];
  const bracket = actionText.match(/\[([^\]]{2,80})\]/);
  if (bracket?.[1]) return bracket[1];
  const selector = actionText.match(/(?:selector|target|element|role)\s*[:=]\s*([^,;]{2,80})/i);
  if (selector?.[1]) return selector[1].trim();
  return `observable target ${stepIndex}`;
}

function actionInputText(actionText: string): string | undefined {
  const fill = actionText.match(/(?:fill|type|press|input)[^"']*["']([^"']{1,120})["']/i);
  return fill?.[1];
}

function actionUrl(actionText: string, urlFallback?: string): string | undefined {
  const url = actionText.match(/https?:\/\/[^\s"'<>]+/i);
  return url?.[0] ?? urlFallback;
}

function buildAudit(sourceType: GuiTraceSourceType, tasks: GuiAgentTask[], sourceFiles: string[], warnings: string[]): GuiTraceAdapterAudit {
  const steps = tasks.flatMap((task) => task.traces.flatMap((trace) => trace.steps));
  return {
    sourceType,
    parsedTaskCount: tasks.length,
    parsedRunCount: tasks.reduce((sum, task) => sum + task.traces.length, 0),
    parsedStepCount: steps.length,
    missingBboxCount: steps.filter((step) => step.sourceWarnings?.some((warning) => warning.includes("bbox"))).length,
    missingTargetLabelCount: steps.filter((step) => step.sourceWarnings?.some((warning) => warning.includes("target label"))).length,
    lowConfidenceStepCount: steps.filter((step) => step.adapterConfidence === "low").length,
    detectedRenderHtmlCount: sourceFiles.filter((file) => /render_.*\.html$/i.test(file)).length,
    detectedMergeLogCount: sourceFiles.filter((file) => /merge[d]?_log\.txt$/i.test(file)).length,
    detectedTraceFileCount: sourceFiles.filter((file) => /(^|\/)trace\/|\.trace$|trace\.zip$/i.test(file)).length,
    warnings,
  };
}

function withTaskAudit(task: GuiAgentTask, audit: GuiTraceAdapterAudit, sourceFiles: string[], warnings: string[]): GuiAgentTask {
  return {
    ...task,
    sourceType: audit.sourceType,
    sourceFiles,
    adapterWarnings: warnings,
    adapterAudit: audit,
  };
}

export function parseNormalizedTraceImport(raw: unknown): GuiTraceImportResult {
  const root = getRecord(raw);
  const candidates = Array.isArray(root.tasks) ? root.tasks : root.task ? [root.task] : Array.isArray(raw) ? raw : [raw];
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = candidates.flatMap((candidate, taskIndex): GuiAgentTask[] => {
    const taskRecord = getRecord(candidate);
    const traces = Array.isArray(taskRecord.traces) ? taskRecord.traces : [];
    if (typeof taskRecord.taskId !== "string" || typeof taskRecord.title !== "string") {
      errors.push(`Task ${taskIndex + 1} is missing taskId or title`);
      return [];
    }
    if (traces.length < 1) {
      errors.push(`Task ${taskRecord.taskId} needs at least one trace`);
      return [];
    }

    const parsedTraces = traces.flatMap((traceCandidate, traceIndex): GuiAgentTrace[] => {
      const traceRecord = getRecord(traceCandidate);
      const steps = Array.isArray(traceRecord.steps) ? traceRecord.steps : [];
      if (typeof traceRecord.traceId !== "string") {
        errors.push(`Task ${taskRecord.taskId} trace ${traceIndex + 1} is missing traceId`);
        return [];
      }
      if (steps.length === 0) {
        errors.push(`Trace ${traceRecord.traceId} has no steps`);
        return [];
      }
      const parsedSteps = steps.flatMap((stepCandidate, stepIndex): GuiAgentTraceStep[] => {
        const stepRecord = getRecord(stepCandidate);
        const target = getRecord(stepRecord.target);
        const stepNumber = asNumber(stepRecord.stepIndex) ?? stepIndex + 1;
        const bbox = parseBbox(target.bbox);
        const actionType = parseActionType(stepRecord.actionType);
        const targetLabel = asString(target.label);
        const stepWarnings = [
          ...(bbox ? [] : ["missing bbox; fallback layout bbox generated"]),
          ...(targetLabel ? [] : ["missing target label; fallback target label generated"]),
        ];
        if (!actionType) {
          errors.push(`Trace ${traceRecord.traceId} step ${stepIndex + 1} is missing actionType`);
          return [];
        }
        return [
          {
            stepIndex: stepNumber,
            observationType: parseObservationType(stepRecord.observationType),
            observationSummary: asString(stepRecord.observationSummary) ?? "Offline trajectory step.",
            actionType,
            target: {
              label: targetLabel ?? `${actionType} target ${stepNumber}`,
              domSelector: asString(target.domSelector) ?? undefined,
              bbox: bbox ?? fallbackBbox(stepNumber),
            },
            inputText: asString(stepRecord.inputText) ?? undefined,
            structuredRationale: asString(stepRecord.structuredRationale) ?? "Observable imported action step.",
            agentOutputExcerpt: asString(stepRecord.agentOutputExcerpt) ?? undefined,
            confidence: asNumber(stepRecord.confidence) ?? (stepWarnings.length > 0 ? 0.35 : 0.7),
            stateAfter: asString(stepRecord.stateAfter) ?? `step_${stepNumber}_complete`,
            url: asString(stepRecord.url) ?? undefined,
            screenshotRef: asString(stepRecord.screenshotRef) ?? undefined,
            thumbnailRef: asString(stepRecord.thumbnailRef) ?? undefined,
            visualFingerprint: asString(stepRecord.visualFingerprint) ?? undefined,
            visualStateSignature: asString(stepRecord.visualStateSignature) ?? undefined,
            sourceRef: asString(stepRecord.sourceRef) ?? undefined,
            sourceHtmlPath: asString(stepRecord.sourceHtmlPath) ?? undefined,
            visualFrameAvailable:
              typeof stepRecord.visualFrameAvailable === "boolean"
                ? stepRecord.visualFrameAvailable
                : Boolean(asString(stepRecord.thumbnailRef) ?? asString(stepRecord.screenshotRef)),
            adapterConfidence:
              stepRecord.adapterConfidence === "high" || stepRecord.adapterConfidence === "medium" || stepRecord.adapterConfidence === "low"
                ? stepRecord.adapterConfidence
                : stepWarnings.length > 0
                  ? "low"
                  : "high",
            sourceWarnings: Array.isArray(stepRecord.sourceWarnings)
              ? stepRecord.sourceWarnings.map(String)
              : stepWarnings.length > 0
                ? stepWarnings
                : undefined,
          },
        ];
      });

      return [
        {
          traceId: traceRecord.traceId,
          agentId: asString(traceRecord.agentId) ?? String(traceRecord.traceId),
          agentKind: parseAgentKind(traceRecord.agentKind),
          modelId: asString(traceRecord.modelId) ?? String(traceRecord.agentId ?? traceRecord.traceId),
          taskId: String(taskRecord.taskId),
          steps: parsedSteps,
          sourceType: "normalized_json",
          sourceLabel: asString(traceRecord.sourceLabel) ?? undefined,
          sourceWarnings: Array.isArray(traceRecord.sourceWarnings) ? traceRecord.sourceWarnings.map(String) : undefined,
          benchmark:
            traceRecord.benchmark === "webarena" || traceRecord.benchmark === "visualwebarena" || traceRecord.benchmark === "custom"
              ? traceRecord.benchmark
              : undefined,
          site: asString(traceRecord.site) ?? undefined,
          sourceCollection: asString(traceRecord.sourceCollection) ?? undefined,
          actorType:
            traceRecord.actorType === "human" || traceRecord.actorType === "model" || traceRecord.actorType === "unknown"
              ? traceRecord.actorType
              : undefined,
          promptSetting: asString(traceRecord.promptSetting) ?? undefined,
          observationMode:
            traceRecord.observationMode === "text" ||
            traceRecord.observationMode === "vision" ||
            traceRecord.observationMode === "mixed" ||
            traceRecord.observationMode === "unknown"
              ? traceRecord.observationMode
              : undefined,
          outcome:
            traceRecord.outcome === "success" || traceRecord.outcome === "failed" || traceRecord.outcome === "unknown"
              ? traceRecord.outcome
              : undefined,
          sourcePath: asString(traceRecord.sourcePath) ?? undefined,
        },
      ];
    });

    if (parsedTraces.length < 1) {
      errors.push(`Task ${taskRecord.taskId} has no valid traces`);
      return [];
    }
    if (!taskRecord.textState || !taskRecord.visualState) {
      warnings.push(`Task ${taskRecord.taskId} uses default text/visual state summaries`);
    }

    return [
      {
        taskId: String(taskRecord.taskId),
        title: String(taskRecord.title),
        domain: asString(taskRecord.domain) ?? "Offline trajectory",
        instruction: asString(taskRecord.instruction) ?? "Inspect paired offline trajectories.",
        startUrl: asString(taskRecord.startUrl) ?? "offline://trajectory",
        successCriteria: asString(taskRecord.successCriteria) ?? "Compare trace divergence and final states.",
        riskTags: Array.isArray(taskRecord.riskTags) ? taskRecord.riskTags.map(String) : ["offline import"],
        textState: asString(taskRecord.textState) ?? "Offline trace observation summaries available.",
        visualState: asString(taskRecord.visualState) ?? "Offline screenshots or render references may be external.",
        screenshotSize: getRecord(taskRecord.screenshotSize).width && getRecord(taskRecord.screenshotSize).height
          ? {
              width: Number(getRecord(taskRecord.screenshotSize).width),
              height: Number(getRecord(taskRecord.screenshotSize).height),
            }
          : defaultScreenshotSize,
        traces: parsedTraces,
        sourceType: "normalized_json",
        sourceLabel: asString(taskRecord.sourceLabel) ?? "Normalized JSON",
        benchmark:
          taskRecord.benchmark === "webarena" || taskRecord.benchmark === "visualwebarena" || taskRecord.benchmark === "custom"
            ? taskRecord.benchmark
            : undefined,
        taskNumericId: asString(taskRecord.taskNumericId) ?? undefined,
        site: asString(taskRecord.site) ?? undefined,
        sourceCollection: asString(taskRecord.sourceCollection) ?? undefined,
        sourcePath: asString(taskRecord.sourcePath) ?? undefined,
        sourceFiles: ["normalized-json"],
      },
    ];
  });

  if (errors.length > 0 || tasks.length === 0) {
    return { ok: false, sourceType: "normalized_json", errors: errors.length ? errors : ["No valid trace tasks found"], warnings };
  }
  const audit = buildAudit("normalized_json", tasks, ["normalized-json"], warnings);
  return { ok: true, tasks: tasks.map((task) => withTaskAudit(task, audit, ["normalized-json"], warnings)), sourceType: "normalized_json", audit, warnings };
}

async function zipTextFiles(data: ArrayBuffer | Uint8Array): Promise<{ files: string[]; textFiles: ZipTextFile[] }> {
  const zip = await JSZip.loadAsync(data);
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const textFiles = await Promise.all(
    files
      .filter((name) => /\.(html|txt|json|trace)$/i.test(name))
      .map(async (name) => ({ path: name, text: await zip.files[name].async("string") })),
  );
  return { files, textFiles };
}

function parseWebArenaStep(
  renderPath: string,
  index: number,
  actionText: string,
  observation: string,
  url?: string,
  screenshotRef?: string,
  rawPrediction?: string,
): GuiAgentTraceStep {
  const stepIndex = index + 1;
  const actionType = parseActionType(actionText) ?? "wait";
  const targetLabel = actionLabel(actionText, stepIndex);
  return {
    stepIndex,
    observationType: screenshotRef ? "mixed" : "dom",
    observationSummary: observation || "WebArena render observation.",
    actionType,
    target: {
      label: targetLabel,
      domSelector: actionText.match(/#[a-z0-9_-]+|\.[a-z0-9_-]+/i)?.[0],
      bbox: fallbackBbox(stepIndex),
    },
    inputText: actionInputText(actionText),
    structuredRationale: `Parsed observable WebArena action: ${actionText.slice(0, 180)}`,
    agentOutputExcerpt: publicExcerpt(rawPrediction),
    confidence: 0.72,
    stateAfter: url ? `url:${url}` : `${sanitizeId(renderPath)}:step-${stepIndex}`,
    url: actionUrl(actionText, url),
    screenshotRef,
    sourceRef: `${renderPath}#step-${stepIndex}`,
    sourceHtmlPath: renderPath,
    visualFrameAvailable: Boolean(screenshotRef),
    adapterConfidence: "medium",
    sourceWarnings: ["bbox unavailable in render html; fallback layout bbox generated"],
  };
}

function inferRunIdFromRenderPath(pathName: string): string {
  const base = pathName.split(/[\\/]/).pop() ?? pathName;
  return sanitizeId(base.replace(/^render_?/i, "").replace(/\.html$/i, ""));
}

function inferTaskIdFromRenderPath(pathName: string): string {
  const base = pathName.split(/[\\/]/).pop() ?? pathName;
  const match = base.match(/^render_?(.+?)\.html$/i);
  return `webarena-task-${sanitizeId(match?.[1] ?? base)}`;
}

function inferRunLabelFromArchive(fileName: string): string {
  return sanitizeId(fileName.replace(/\.(zip|tar|gz)$/i, ""));
}

function parseMergeLogOutcomes(textFiles: ZipTextFile[]): Map<string, string> {
  const mergeLog = textFiles.find((file) => /merge[d]?_log\.txt$/i.test(file.path));
  const outcomes = new Map<string, string>();
  if (!mergeLog) return outcomes;
  let activeTaskId: string | null = null;
  mergeLog.text.split(/\r?\n/).forEach((line) => {
    const configId = line.match(/\[Config file\]:.*?([0-9]+)\.json/i)?.[1];
    if (configId) {
      activeTaskId = `webarena-task-${sanitizeId(configId)}`;
      return;
    }
    const renderId = line.match(/render_?([a-z0-9_-]+)/i)?.[1];
    const taskId = renderId ? `webarena-task-${sanitizeId(renderId)}` : activeTaskId;
    if (!taskId) return;
    const normalized = line.toLowerCase();
    const outcome = normalized.includes("success") || normalized.includes("pass") ? "success" : normalized.includes("fail") ? "failed" : "";
    if (outcome) outcomes.set(taskId, outcome);
  });
  return outcomes;
}

export async function parseWebArenaExecutionBundle(data: ArrayBuffer | Uint8Array, fileName = "webarena-execution.zip"): Promise<GuiTraceImportResult> {
  try {
    const { files, textFiles } = await zipTextFiles(data);
    const renderFiles = textFiles.filter((file) => /render_.*\.html$/i.test(file.path) || /(^|\/)render\.html$/i.test(file.path));
    const warnings: string[] = [];
    if (renderFiles.length === 0) {
      return {
        ok: false,
        sourceType: "webarena_execution_bundle",
        errors: ["No render_*.html file found in WebArena execution bundle"],
        warnings,
      };
    }

    const traces = renderFiles.flatMap((file): GuiAgentTrace[] => {
      const actions = extractClassText(file.text, "action_object");
      const observations = extractClassText(file.text, "state_obv");
      const urls = extractClassText(file.text, "url");
      const rawPredictions = extractClassText(file.text, "raw_parsed_prediction");
      const screenshots = extractScreenshotRefs(file.text);
      if (actions.length === 0) {
        warnings.push(`${file.path} has no action_object entries`);
      }
      const steps = (actions.length > 0 ? actions : ["wait for page state"]).map((action, index) =>
        parseWebArenaStep(
          file.path,
          index,
          action,
          observations[index] ?? observations[0] ?? "",
          urls[index] ?? urls[0],
          screenshots[index],
          rawPredictions[index] ?? rawPredictions[0],
        ),
      );
      const runId = inferRunIdFromRenderPath(file.path);
      return [
        {
          traceId: `webarena-${runId}`,
          agentId: runId,
          agentKind: "offline_run",
          modelId: runId,
          taskId: sanitizeId(fileName),
          steps,
          sourceType: "webarena_execution_bundle",
          sourceLabel: file.path,
          sourceWarnings: warnings,
        },
      ];
    });

    if (traces.length < 2 && traces.length === 1) {
      warnings.push("Only one WebArena run was detected; duplicated as reference so the inspector can render, but comparison evidence is limited.");
      const copy = {
        ...traces[0],
        traceId: `${traces[0].traceId}-reference`,
        agentId: `${traces[0].agentId}-reference`,
        modelId: `${traces[0].modelId}-reference`,
        steps: traces[0].steps.map((step) => ({ ...step })),
      };
      traces.push(copy);
    }

    const firstUrl = traces[0]?.steps.find((step) => step.url)?.url ?? "offline://webarena";
    const task: GuiAgentTask = {
      taskId: sanitizeId(fileName),
      title: `WebArena execution bundle: ${fileName}`,
      instruction: "Inspect offline WebArena execution traces parsed from render HTML.",
      domain: "WebArena offline execution",
      startUrl: firstUrl,
      successCriteria: "Compare observable parsed actions, page states, URLs, and screenshot references.",
      riskTags: ["offline", "webarena", "model trace"],
      textState: "Accessibility observations from render_*.html are normalized into step summaries.",
      visualState: "Screenshot references are retained when render HTML points to image files.",
      screenshotSize: defaultScreenshotSize,
      traces,
      sourceType: "webarena_execution_bundle",
      sourceLabel: fileName,
      sourceFiles: files,
    };
    const audit = buildAudit("webarena_execution_bundle", [task], files, warnings);
    return { ok: true, tasks: [withTaskAudit(task, audit, files, warnings)], sourceType: "webarena_execution_bundle", audit, warnings };
  } catch (error) {
    return {
      ok: false,
      sourceType: "webarena_execution_bundle",
      errors: [`Failed to parse WebArena execution bundle: ${error instanceof Error ? error.message : "unknown error"}`],
      warnings: [],
    };
  }
}

export async function parseWebArenaOfficialRunArchive(
  data: ArrayBuffer | Uint8Array,
  fileName = "webarena-run.zip",
  runLabel = inferRunLabelFromArchive(fileName),
): Promise<GuiTraceImportResult> {
  try {
    const { files, textFiles } = await zipTextFiles(data);
    const renderFiles = textFiles.filter((file) => /render_.*\.html$/i.test(file.path) || /(^|\/)render\.html$/i.test(file.path));
    const warnings: string[] = [];
    if (renderFiles.length === 0) {
      return {
        ok: false,
        sourceType: "webarena_execution_bundle",
        errors: ["No render_*.html file found in WebArena official run archive"],
        warnings,
      };
    }

    const outcomes = parseMergeLogOutcomes(textFiles);
    const tasks = renderFiles.map((file): GuiAgentTask => {
      const taskId = inferTaskIdFromRenderPath(file.path);
      const actions = extractClassText(file.text, "action_object");
      const observations = extractClassText(file.text, "state_obv");
      const urls = extractClassText(file.text, "url");
      const rawPredictions = extractClassText(file.text, "raw_parsed_prediction");
      const screenshots = extractScreenshotRefs(file.text);
      if (actions.length === 0) warnings.push(`${file.path} has no action_object entries`);
      const steps = (actions.length > 0 ? actions : ["wait for page state"]).map((action, index) =>
        parseWebArenaStep(
          file.path,
          index,
          action,
          observations[index] ?? observations[0] ?? "",
          urls[index] ?? urls[0],
          screenshots[index],
          rawPredictions[index] ?? rawPredictions[0],
        ),
      );
      const outcome = outcomes.get(taskId);
      const trace: GuiAgentTrace = {
        traceId: `${taskId}-${sanitizeId(runLabel)}`,
        agentId: sanitizeId(runLabel),
        agentKind: "offline_run",
        modelId: runLabel,
        taskId,
        steps,
        sourceType: "webarena_execution_bundle",
        sourceLabel: `${fileName}:${file.path}`,
        sourceWarnings: [
          "Official WebArena execution archive parsed from render HTML; raw prediction is not treated as private reasoning.",
          ...(outcome ? [`merge_log outcome: ${outcome}`] : []),
        ],
      };
      const firstUrl = steps.find((step) => step.url)?.url ?? "offline://webarena";
      return {
        taskId,
        title: `Official WebArena task ${taskId.replace(/^webarena-task-/, "")}`,
        instruction: `Official WebArena task ${taskId.replace(/^webarena-task-/, "")}; attach the task config file for the original instruction text.`,
        domain: "Official WebArena trajectory",
        startUrl: firstUrl,
        successCriteria: outcome ? `Run outcome in merge_log: ${outcome}` : "Compare official observable execution trajectories for this task.",
        riskTags: ["official-webarena", outcome ?? "outcome-unknown"],
        textState: observations[0] ?? "Accessibility observations are available in render HTML.",
        visualState: screenshots[0] ? `Screenshot reference: ${screenshots[0]}` : "Screenshot references may be available in the archive.",
        screenshotSize: defaultScreenshotSize,
        traces: [trace],
        sourceType: "webarena_execution_bundle",
        sourceLabel: fileName,
        sourceFiles: files,
      };
    });

    const audit = buildAudit("webarena_execution_bundle", tasks, files, warnings);
    return { ok: true, tasks: tasks.map((task) => withTaskAudit(task, audit, files, warnings)), sourceType: "webarena_execution_bundle", audit, warnings };
  } catch (error) {
    return {
      ok: false,
      sourceType: "webarena_execution_bundle",
      errors: [`Failed to parse WebArena official run archive: ${error instanceof Error ? error.message : "unknown error"}`],
      warnings: [],
    };
  }
}

function parseHumanActionsFromText(file: ZipTextFile): GuiAgentTraceStep[] {
  const lines = file.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates: HumanActionCandidate[] = lines.flatMap((line): HumanActionCandidate[] => {
    try {
      const parsed = JSON.parse(line);
      const method = asString(parsed.method ?? parsed.type ?? parsed.apiName ?? parsed.call);
      const params = getRecord(parsed.params);
      const url = asString(parsed.url ?? params.url);
      const x = asNumber(parsed.x ?? params.x);
      const y = asNumber(parsed.y ?? params.y);
      const selector = asString(parsed.selector ?? params.selector);
      const text = asString(parsed.text ?? params.text ?? parsed.value ?? params.value);
      return method ? [{ method, url, x, y, selector, text, raw: line }] : [];
    } catch {
      const method = parseActionType(line);
      return method ? [{ method, url: actionUrl(line) ?? null, x: null, y: null, selector: null, text: actionInputText(line) ?? null, raw: line }] : [];
    }
  });

  return candidates
    .filter((candidate) => parseActionType(candidate.method))
    .map((candidate, index): GuiAgentTraceStep => {
      const stepIndex = index + 1;
      const actionType = parseActionType(candidate.method) ?? "wait";
      const hasPoint = typeof candidate.x === "number" && typeof candidate.y === "number";
      const label = candidate.selector ?? (hasPoint ? `browser ${actionType} at ${candidate.x},${candidate.y}` : `browser ${actionType} ${stepIndex}`);
      return {
        stepIndex,
        observationType: "mixed",
        observationSummary: candidate.url ? `Human browser action near ${candidate.url}` : "Human Playwright browser action.",
        actionType,
        target: {
          label,
          domSelector: candidate.selector ?? undefined,
          bbox: hasPoint ? [candidate.x as number, candidate.y as number, 24, 24] : fallbackBbox(stepIndex),
        },
        inputText: candidate.text ?? undefined,
        structuredRationale: "Observable human browser interaction parsed from Playwright trace.",
        confidence: candidate.selector ? 0.58 : 0.34,
        stateAfter: candidate.url ? `url:${candidate.url}` : `${sanitizeId(file.path)}:step-${stepIndex}`,
        url: candidate.url ?? undefined,
        sourceRef: `${file.path}#event-${stepIndex}`,
        adapterConfidence: candidate.selector ? "medium" : "low",
        sourceWarnings: candidate.selector ? undefined : ["semantic target label unavailable; fallback browser action target generated"],
      };
    });
}

export async function parseHumanPlaywrightTraceBundle(data: ArrayBuffer | Uint8Array, fileName = "human-trace.zip"): Promise<GuiTraceImportResult> {
  try {
    const { files, textFiles } = await zipTextFiles(data);
    const warnings: string[] = [];
    const traceTextFiles = textFiles.filter((file) => /\.trace$|\.json$/i.test(file.path));
    const steps = traceTextFiles.flatMap(parseHumanActionsFromText).slice(0, 80);
    if (steps.length === 0) {
      warnings.push("No click/type/navigate events were recoverable; created one low-confidence placeholder step.");
      steps.push({
        stepIndex: 1,
        observationType: "mixed",
        observationSummary: "Human Playwright trace zip was detected, but semantic actions were not recoverable.",
        actionType: "wait",
        target: { label: "human trace playback", bbox: fallbackBbox(1) },
        structuredRationale: "Observable trace file detected; action extraction unavailable.",
        confidence: 0.2,
        stateAfter: "human_trace_loaded",
        sourceRef: files[0] ?? fileName,
        adapterConfidence: "low",
        sourceWarnings: ["no semantic Playwright action recovered from trace payload"],
      });
    }
    const taskId = sanitizeId(fileName);
    const humanTrace: GuiAgentTrace = {
      traceId: `${taskId}-human`,
      agentId: "human-reference",
      agentKind: "human",
      modelId: "human-reference",
      taskId,
      steps,
      sourceType: "playwright_human_trace",
      sourceLabel: fileName,
      sourceWarnings: warnings,
    };
    const comparisonTrace: GuiAgentTrace = {
      ...humanTrace,
      traceId: `${taskId}-comparison-placeholder`,
      agentId: "comparison-placeholder",
      agentKind: "offline_run",
      modelId: "comparison-placeholder",
      steps: steps.map((step) => ({ ...step, sourceWarnings: [...(step.sourceWarnings ?? []), "placeholder duplicate; import a model run for real comparison"] })),
      sourceWarnings: ["Placeholder duplicate created because a single human trace was uploaded."],
    };
    warnings.push("Human trace imports are best-effort and may need a paired model trace for meaningful comparison.");
    const task: GuiAgentTask = {
      taskId,
      title: `Human Playwright trajectory: ${fileName}`,
      instruction: "Inspect a human WebArena trajectory parsed from a Playwright trace zip.",
      domain: "WebArena human trajectory",
      startUrl: steps.find((step) => step.url)?.url ?? "offline://human-playwright-trace",
      successCriteria: "Use as a human reference trajectory, ideally paired with an imported model execution trace.",
      riskTags: ["offline", "human trajectory", "best effort adapter"],
      textState: "Human browser actions are parsed from Playwright trace payloads when possible.",
      visualState: "Trace snapshots remain external; use playwright show-trace for full playback.",
      screenshotSize: defaultScreenshotSize,
      traces: [humanTrace, comparisonTrace],
      sourceType: "playwright_human_trace",
      sourceLabel: fileName,
      sourceFiles: files,
    };
    const audit = buildAudit("playwright_human_trace", [task], files, warnings);
    return { ok: true, tasks: [withTaskAudit(task, audit, files, warnings)], sourceType: "playwright_human_trace", audit, warnings };
  } catch (error) {
    return {
      ok: false,
      sourceType: "playwright_human_trace",
      errors: [`Failed to parse human Playwright trace: ${error instanceof Error ? error.message : "unknown error"}`],
      warnings: [],
    };
  }
}

export async function importTrajectoryFile(file: FileLike, requestedSourceType?: GuiTraceSourceType): Promise<GuiTraceImportResult> {
  const sourceType =
    requestedSourceType ??
    (file.name.toLowerCase().endsWith(".json")
      ? "normalized_json"
      : file.name.toLowerCase().includes("human")
        ? "playwright_human_trace"
        : "webarena_execution_bundle");
  if (sourceType === "normalized_json") {
    try {
      return parseNormalizedTraceImport(JSON.parse(await file.text()));
    } catch (error) {
      return {
        ok: false,
        sourceType,
        errors: [`Invalid normalized JSON: ${error instanceof Error ? error.message : "parse failed"}`],
        warnings: [],
      };
    }
  }
  const bytes = await file.arrayBuffer();
  if (sourceType === "playwright_human_trace") {
    return parseHumanPlaywrightTraceBundle(bytes, file.name);
  }
  return parseWebArenaExecutionBundle(bytes, file.name);
}
