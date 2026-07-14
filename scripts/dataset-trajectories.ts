import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import type {
  GuiAgentActionType,
  GuiAgentTask,
  GuiAgentTrace,
  GuiAgentTraceStep,
  GuiTraceBenchmark,
} from "../src/projectTypes";

export type DatasetImportOptions = {
  rootDir: string;
  writeThumbnails?: boolean;
  thumbnailLimitPerRun?: number;
  maxTasksPerCollection?: number;
  collectionFilter?: string;
  progress?: boolean;
};

export type DatasetAuditSummary = {
  generatedAt: string;
  rootDir: string;
  collectionCount: number;
  collections: Array<{
    name: string;
    benchmark: GuiTraceBenchmark;
    actorType: "human" | "model" | "unknown";
    renderHtmlCount: number;
    mergeLogCount: number;
    traceZipCount: number;
    parsedTaskCount: number;
    parsedRunCount: number;
    parsedStepCount: number;
  }>;
  taskCount: number;
  comparableTaskCount: number;
  runCount: number;
  stepCount: number;
  boundary: string[];
  warnings: string[];
};

const thumbnailWidth = 520;
const thumbnailQuality = 74;

const defaultScreenshotSize = { width: 1280, height: 820 };

function sanitizeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "trajectory"
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

function extractClassText(html: string, className: string): string[] {
  const pattern = new RegExp(`<[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "gi");
  return [...html.matchAll(pattern)].map((match) => stripHtml(match[1] ?? "")).filter(Boolean);
}

function extractInitialConfig(html: string): MergeLogEntry {
  const firstPre = html.match(/<pre>([\s\S]*?)<\/pre>/i)?.[1] ?? "";
  const text = stripHtml(firstPre);
  const intent = text.match(/\bintent:\s*(.+?)(?:\s+image:|\s+instantiation_dict:|\s+require_reset:|$)/i)?.[1]?.trim();
  const referenceAnswers = text.match(/\breference_answers:\s*(.+?)(?:\s+reference_url:|\s+program_html:|\s+string_note:|$)/i)?.[1]?.trim();
  return {
    intent,
    referenceAnswers: referenceAnswers ? shortText(referenceAnswers, 140) : undefined,
  };
}

function extractImageSources(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => decodeHtml(match[1] ?? "")).filter(Boolean);
}

function shortText(value: string | undefined, max = 220): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "No observable summary recovered.";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function publicExcerpt(value: string | undefined, max = 320): string | undefined {
  const normalized = shortText(value, max)
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?[^\s"'<>]*/gi, "[local url removed]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[web page]")
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/gi, "[local host]")
    .replace(/(^|[\s"'(])[a-z]:[\\/][^\s"'<>]+/gi, "$1[local path removed]")
    .replace(/\b(?:file|embedded|zip):[^\s"'<>]+/gi, "[source ref]")
    .trim();
  return normalized && normalized !== "No observable summary recovered." ? normalized : undefined;
}

function parseActionType(value: string | undefined): GuiAgentActionType {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("click") || normalized.includes("tap")) return "click";
  if (normalized.includes("fill") || normalized.includes("type") || normalized.includes("press") || normalized.includes("input")) return "type";
  if (normalized.includes("scroll")) return "scroll";
  if (normalized.includes("select") || normalized.includes("choose")) return "select";
  if (normalized.includes("goto") || normalized.includes("navigate") || normalized.includes("open")) return "navigate";
  if (normalized.includes("wait")) return "wait";
  return "click";
}

function actionLabel(actionText: string, stepIndex: number): string {
  const quoted = actionText.match(/["']([^"']{2,96})["']/);
  if (quoted?.[1]) return quoted[1];
  const selector = actionText.match(/(?:selector|target|element|role)\s*[:=]\s*([^,;]{2,96})/i);
  if (selector?.[1]) return selector[1].trim();
  return `observable target ${stepIndex}`;
}

function actionUrl(actionText: string, fallback?: string): string | undefined {
  return actionText.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? fallback;
}

function actionInputText(actionText: string): string | undefined {
  return actionText.match(/(?:fill|type|press|input)[^"']*["']([^"']{1,160})["']/i)?.[1];
}

function fallbackBbox(stepIndex: number): [number, number, number, number] {
  return [64 + ((stepIndex - 1) % 5) * 96, 72 + Math.floor((stepIndex - 1) / 5) * 72, 88, 36];
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashShort(value: string | undefined): string {
  return stableHash(value ?? "").toString(36).slice(0, 7);
}

async function visualStateSignatureFromBuffer(buffer: Buffer): Promise<string | undefined> {
  try {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const regions: Array<sharp.Region | undefined> = [undefined];
    if (width >= 32 && height >= 32) {
      regions.push(
        { left: 0, top: 0, width, height: Math.max(1, Math.floor(height * 0.62)) },
        {
          left: 0,
          top: Math.max(0, Math.floor(height * 0.18)),
          width,
          height: Math.max(1, Math.floor(height * 0.64)),
        },
      );
    }
    const hashes: string[] = [];
    for (const region of regions) {
      let image = sharp(buffer, { limitInputPixels: false });
      if (region) image = image.extract(region);
      const { data } = await image.resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
      let bits = "";
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
        }
      }
      hashes.push(BigInt(`0b${bits}`).toString(16).padStart(16, "0"));
    }
    return [...new Set(hashes)].join(";");
  } catch {
    return undefined;
  }
}

async function listFilesRecursive(dir: string, skipDirectory?: (fullPath: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return skipDirectory?.(fullPath) ? [] : listFilesRecursive(fullPath, skipDirectory);
      return [fullPath];
    }),
  );
  return nested.flat();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function inferBenchmark(collection: string): GuiTraceBenchmark {
  if (collection.toLowerCase().includes("visual_webarena")) return "visualwebarena";
  if (collection.toLowerCase().includes("webarena")) return "webarena";
  return "custom";
}

function inferActorType(collection: string): "human" | "model" | "unknown" {
  return collection.toLowerCase().includes("human") ? "human" : collection.toLowerCase().includes("gpt") ? "model" : "unknown";
}

function inferSite(filePath: string, benchmark: GuiTraceBenchmark): string | undefined {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  if (benchmark !== "visualwebarena") return undefined;
  return ["classifieds", "reddit", "shopping"].find((site) => lower.includes(site));
}

function inferTaskNumericId(filePath: string): string {
  const base = path.basename(filePath);
  return base.match(/(?:render_)?([0-9]+)(?:\.trace)?\.(?:html|zip)$/i)?.[1] ?? sanitizeId(base);
}

function taskIdFor(benchmark: GuiTraceBenchmark, taskNumericId: string, site?: string): string {
  return benchmark === "visualwebarena" ? `visualwebarena-${site ?? "unknown"}-${taskNumericId}` : `${benchmark}-${taskNumericId}`;
}

function inferModelId(collection: string, renderPath: string): string {
  const lower = `${collection}/${renderPath}`.toLowerCase();
  if (lower.includes("gpt4v")) return "gpt-4-vision-preview";
  if (lower.includes("gpt4")) return "gpt4-0613-cot";
  if (lower.includes("gpt35") || lower.includes("gpt3.5")) return "gpt3.5-turbo-0613-cot";
  if (lower.includes("human")) return "human-reference";
  return collection;
}

function inferObservationMode(collection: string, renderPath: string): GuiAgentTrace["observationMode"] {
  const lower = `${collection}/${renderPath}`.toLowerCase();
  if (lower.includes("visual") || lower.includes("gpt4v") || lower.includes("image")) return "vision";
  if (lower.includes("human")) return "mixed";
  return "text";
}

function inferPromptSetting(collection: string): string | undefined {
  const lower = collection.toLowerCase();
  if (lower.includes("direct")) return "direct";
  if (lower.includes("cot")) return "cot";
  if (lower.includes("som")) return "som";
  return undefined;
}

function progressLog(options: DatasetImportOptions, message: string) {
  if (options.progress) {
    console.error(message);
  }
}

async function writeImageRef(
  imageSrc: string | undefined,
  options: DatasetImportOptions,
  relativeId: string,
  visualFrameAvailable: boolean,
): Promise<{ screenshotRef?: string; thumbnailRef?: string; visualFrameAvailable: boolean; visualFingerprint?: string; visualStateSignature?: string }> {
  if (!imageSrc) return { visualFrameAvailable };
  if (!imageSrc.startsWith("data:image/")) {
    return { screenshotRef: imageSrc, visualFrameAvailable: true, visualFingerprint: `ref:${hashShort(imageSrc)}` };
  }
  if (!options.writeThumbnails) {
    return { screenshotRef: `embedded:${relativeId}`, visualFrameAvailable: true };
  }
  const match = imageSrc.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return { screenshotRef: `embedded:${relativeId}`, visualFrameAvailable: true };
  const visualFingerprint = `embedded:${hashShort(match[2])}`;
  const imageBuffer = Buffer.from(match[2], "base64");
  const visualStateSignature = await visualStateSignatureFromBuffer(imageBuffer);
  const outputRelative = path.join("trajectory-thumbnails", `${sanitizeId(relativeId)}.webp`);
  const outputPath = path.resolve("public", outputRelative);
  if (await fileExists(outputPath)) {
    return {
      screenshotRef: `embedded:${relativeId}`,
      thumbnailRef: `/${outputRelative.replace(/\\/g, "/")}`,
      visualFrameAvailable: true,
      visualFingerprint,
      visualStateSignature,
    };
  }
  const thumbnail = await sharp(imageBuffer)
    .resize({ width: thumbnailWidth, withoutEnlargement: true })
    .webp({ quality: thumbnailQuality })
    .toBuffer();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, thumbnail);
  return {
    screenshotRef: `embedded:${relativeId}`,
    thumbnailRef: `/${outputRelative.replace(/\\/g, "/")}`,
    visualFrameAvailable: true,
    visualFingerprint,
    visualStateSignature,
  };
}

function listZipEntries(filePath: string): string[] {
  const result = spawnSync("tar", ["-tf", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readZipEntryText(filePath: string, entryName: string, maxBuffer = 24 * 1024 * 1024): string | null {
  const result = spawnSync("tar", ["-xOf", filePath, entryName], { encoding: "utf8", maxBuffer });
  return result.status === 0 ? result.stdout : null;
}

function readZipEntryBytes(filePath: string, entryName: string): Buffer | null {
  const result = spawnSync("tar", ["-xOf", filePath, entryName], { encoding: "buffer", maxBuffer: 24 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

type HumanVisualFrame = {
  entry: string;
  sha1: string;
  timestamp?: number;
  width?: number;
  height?: number;
};

function extractHumanVisualFrames(traceText: string, zipEntries: string[]): HumanVisualFrame[] {
  const imageEntries = new Map(
    zipEntries
      .filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry))
      .map((entry) => [path.basename(entry), entry]),
  );
  const frames = new Map<string, HumanVisualFrame>();
  for (const line of traceText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "screencast-frame" || typeof record.sha1 !== "string") continue;
      const entry = imageEntries.get(record.sha1);
      if (!entry || frames.has(record.sha1)) continue;
      frames.set(record.sha1, {
        entry,
        sha1: record.sha1,
        timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
        width: typeof record.width === "number" ? record.width : undefined,
        height: typeof record.height === "number" ? record.height : undefined,
      });
    } catch {
      // Ignore malformed trace lines.
    }
  }
  if (frames.size > 0) {
    return [...frames.values()].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  }
  return [...imageEntries.values()]
    .filter((entry) => /(^|\/)resources\/page@/i.test(entry) || /screenshot|page@/i.test(entry))
    .map((entry) => ({
      entry,
      sha1: path.basename(entry),
      timestamp: Number(entry.match(/-([0-9]+(?:\.[0-9]+)?)\.(?:png|jpe?g|webp)$/i)?.[1]),
    }))
    .sort((left, right) => (Number.isFinite(left.timestamp) ? left.timestamp : 0) - (Number.isFinite(right.timestamp) ? right.timestamp : 0));
}

function chooseHumanFrame(
  frames: HumanVisualFrame[],
  actionTime: number | undefined,
  stepIndex: number,
  stepCount: number,
  usedFrames: Set<string>,
): HumanVisualFrame | undefined {
  if (frames.length === 0) return undefined;
  let candidateIndex = -1;
  if (typeof actionTime === "number" && Number.isFinite(actionTime)) {
    const targetTime = actionTime + 350;
    candidateIndex = frames.findIndex((frame) => typeof frame.timestamp === "number" && frame.timestamp >= targetTime);
    if (candidateIndex === -1) {
      candidateIndex = frames.findIndex((frame) => typeof frame.timestamp === "number" && frame.timestamp >= actionTime);
    }
  }
  if (candidateIndex === -1) {
    candidateIndex = Math.round(((stepIndex - 1) * Math.max(frames.length - 1, 0)) / Math.max(stepCount - 1, 1));
  }
  for (let index = candidateIndex; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame && !usedFrames.has(frame.sha1)) return frame;
  }
  for (let index = candidateIndex - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame && !usedFrames.has(frame.sha1)) return frame;
  }
  return undefined;
}

type MergeLogEntry = {
  intent?: string;
  outcome?: "success" | "failed" | "unknown";
  referenceAnswers?: string;
};

function isGenericInstruction(value: string): boolean {
  return /^Inspect (official|human trajectory|an imported|a human reference)/i.test(value) || /^Compare observable/i.test(value);
}

function isInformativeInstruction(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0 && !isGenericInstruction(value));
}

async function parseMergeLogs(files: string[]): Promise<Map<string, MergeLogEntry>> {
  const map = new Map<string, MergeLogEntry>();
  for (const file of files.filter((candidate) => /merge[d]?_log\.txt$/i.test(candidate))) {
    const text = await fs.readFile(file, "utf8");
    let activeId: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const configId = line.match(/\[Config file\]:.*?([0-9]+)\.json/i)?.[1];
      if (configId) {
        activeId = configId;
        map.set(activeId, { ...(map.get(activeId) ?? {}) });
        continue;
      }
      if (!activeId) continue;
      const intent = line.match(/\[Intent\]:\s*(.+)$/i)?.[1]?.trim();
      if (intent) map.set(activeId, { ...(map.get(activeId) ?? {}), intent });
      const result = line.match(/\[Result\]\s*\(([^)]+)\)/i)?.[1]?.toLowerCase();
      if (result) {
        map.set(activeId, { ...(map.get(activeId) ?? {}), outcome: result.includes("pass") || result.includes("success") ? "success" : "failed" });
      }
    }
  }
  return map;
}

function actionObjectField(actionObject: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = actionObject.match(new RegExp(`['"]${escaped}['"]\\s*:\\s*['"]([^'"]*)['"]`, "i"))?.[1]?.trim();
  if (quoted) return quoted;
  const list = actionObject.match(new RegExp(`['"]${escaped}['"]\\s*:\\s*\\[([^\\]]*)\\]`, "i"))?.[1]?.trim();
  if (list) return list.replace(/['"]/g, "").trim();
  return undefined;
}

function actionObjectElementId(actionObject: string, parsedAction: string): string | undefined {
  return actionObjectField(actionObject, "element_id") || parsedAction.match(/\[(\d+)\]/)?.[1];
}

function actionTargetLabel(actionObject: string, parsedAction: string, stepIndex: number): string {
  const elementName = actionObjectField(actionObject, "element_name");
  if (elementName) return elementName;
  const answer = actionObjectField(actionObject, "answer");
  if (answer) return answer;
  const text = actionObjectField(actionObject, "text");
  if (text) return text;
  const quoted = parsedAction.match(/["']([^"']{2,96})["']/)?.[1];
  if (quoted) return quoted;
  const elementId = actionObjectElementId(actionObject, parsedAction);
  if (elementId) return `element ${elementId}`;
  return actionLabel(parsedAction || actionObject, stepIndex);
}

function bboxFromAction(actionObject: string, parsedAction: string, stepIndex: number): [number, number, number, number] {
  const coords = actionObject.match(/coords['"]?:\s*array\(\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]/i);
  if (coords) {
    const x = Number(coords[1]);
    const y = Number(coords[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && (x > 0 || y > 0)) return [Math.max(0, x - 44), Math.max(0, y - 18), 88, 36];
  }
  const elementId = Number(actionObjectElementId(actionObject, parsedAction));
  if (Number.isFinite(elementId) && elementId > 0) {
    return [48 + (elementId % 9) * 104, 68 + (Math.floor(elementId / 9) % 12) * 58, 88, 36];
  }
  return fallbackBbox(stepIndex);
}

function stateAfterSignature({
  taskId,
  stepIndex,
  url,
  actionType,
  targetLabel,
  observation,
  parsedAction,
}: {
  taskId: string;
  stepIndex: number;
  url?: string;
  actionType: GuiAgentActionType;
  targetLabel: string;
  observation?: string;
  parsedAction: string;
}): string {
  const page = url ? publicExcerpt(url, 120)?.replace(/^URL:\s*/i, "") : `${taskId}:step-${stepIndex}`;
  return `page:${page ?? taskId}|action:${actionType}|target:${sanitizeId(targetLabel)}|obs:${hashShort(observation)}|parsed:${sanitizeId(parsedAction).slice(0, 36)}`;
}

async function parseRenderFile({
  filePath,
  collection,
  collectionRoot,
  mergeLog,
  options,
}: {
  filePath: string;
  collection: string;
  collectionRoot: string;
  mergeLog: Map<string, MergeLogEntry>;
  options: DatasetImportOptions;
}): Promise<GuiAgentTask> {
  const benchmark = inferBenchmark(collection);
  const site = inferSite(filePath, benchmark);
  const taskNumericId = inferTaskNumericId(filePath);
  const taskId = taskIdFor(benchmark, taskNumericId, site);
  const html = await fs.readFile(filePath, "utf8");
  const actions = extractClassText(html, "action_object");
  const parsedActions = extractClassText(html, "parsed_action");
  const observations = extractClassText(html, "state_obv");
  const urls = extractClassText(html, "url");
  const rawPredictions = extractClassText(html, "raw_parsed_prediction");
  const images = extractImageSources(html);
  const pageConfig = extractInitialConfig(html);
  const relativePath = path.relative(options.rootDir, filePath).replace(/\\/g, "/");
  const sourceCollection = collection;
  const modelId = inferModelId(collection, filePath);
  const runId = `${taskId}-${sanitizeId(sourceCollection)}-${sanitizeId(modelId)}`;
  const steps: GuiAgentTraceStep[] = [];
  const stepInputs = actions.length > 0 ? actions : ["wait for page state"];
  for (const [index, action] of stepInputs.entries()) {
    const stepIndex = index + 1;
    const image = images[index] ?? images[0];
    const refs = await writeImageRef(image, options, `${sourceCollection}-${site ?? "site"}-${taskNumericId}-${stepIndex}`, Boolean(images[index] ?? images[0]));
    const parsedAction = parsedActions[index] ?? action;
    const actionType = parseActionType(parsedAction || action);
    const targetLabel = actionTargetLabel(action, parsedAction, stepIndex);
    const url = actionUrl(parsedAction, urls[index] ?? urls[0]);
    const observation = observations[index] ?? observations[0];
    steps.push({
      stepIndex,
      observationType: refs.visualFrameAvailable ? "mixed" : "dom",
      observationSummary: shortText(observation),
      actionType,
      target: {
        label: targetLabel,
        domSelector: parsedAction.match(/#[a-z0-9_-]+|\.[a-z0-9_-]+/i)?.[0],
        bbox: bboxFromAction(action, parsedAction, stepIndex),
      },
      inputText: actionInputText(parsedAction) ?? actionObjectField(action, "text"),
      structuredRationale: `Observable parsed action from ${sourceCollection}: ${shortText(parsedAction, 160)}`,
      agentOutputExcerpt: publicExcerpt(rawPredictions[index] ?? rawPredictions[0]),
      confidence: 0.72,
      stateAfter: stateAfterSignature({ taskId, stepIndex, url, actionType, targetLabel, observation, parsedAction }),
      url,
      screenshotRef: refs.screenshotRef,
      thumbnailRef: refs.thumbnailRef,
      visualFingerprint: refs.visualFingerprint,
      visualStateSignature: refs.visualStateSignature,
      sourceRef: `${relativePath}#step-${stepIndex}`,
      sourceHtmlPath: relativePath,
      visualFrameAvailable: refs.visualFrameAvailable,
      adapterConfidence: "medium",
      sourceWarnings: ["bbox unavailable in render HTML; fallback layout bbox generated"],
    });
  }
  const merge = { ...pageConfig, ...(mergeLog.get(taskNumericId) ?? {}) };
  const instruction = merge.intent ?? `Inspect official ${benchmark} task ${taskNumericId}.`;
  const trace: GuiAgentTrace = {
    traceId: runId,
    agentId: sanitizeId(modelId),
    agentKind: inferActorType(collection) === "human" ? "human" : "offline_run",
    modelId,
    taskId,
    steps,
    sourceType: "webarena_execution_bundle",
    sourceLabel: sourceCollection,
    sourceWarnings: ["Parsed from official render HTML; raw prediction is not analyzed as private reasoning."],
    benchmark,
    site,
    sourceCollection,
    actorType: inferActorType(collection),
    promptSetting: inferPromptSetting(`${collection}/${filePath}`),
    observationMode: inferObservationMode(collection, filePath),
    outcome: merge?.outcome ?? "unknown",
    sourcePath: relativePath,
  };
  return {
    taskId,
    title: merge?.intent ? shortText(merge.intent, 110) : `${benchmark} task ${site ? `${site} ` : ""}${taskNumericId}`,
    instruction,
    domain: site ? `${benchmark} / ${site}` : benchmark,
    startUrl: steps.find((step) => step.url)?.url ?? `offline://${benchmark}/${taskNumericId}`,
    successCriteria: merge?.referenceAnswers
      ? `Reference answer constraint: ${merge.referenceAnswers}`
      : merge?.outcome
        ? `Official run outcome: ${merge.outcome}`
        : "Compare observable execution trajectory against another run of the same task.",
    riskTags: [benchmark, site ?? "site-unknown", inferActorType(collection), merge?.outcome ?? "outcome-unknown"],
    textState: observations[0] ?? "Accessibility observations are available in render HTML.",
    visualState: images[0] ? "Rendered screenshots are available for this trajectory." : "No rendered screenshot was found for this trajectory.",
    screenshotSize: defaultScreenshotSize,
    traces: [trace],
    sourceType: "webarena_execution_bundle",
    sourceLabel: sourceCollection,
    benchmark,
    taskNumericId,
    site,
    sourceCollection,
    sourcePath: path.relative(options.rootDir, collectionRoot).replace(/\\/g, "/"),
    sourceFiles: [relativePath],
  };
}

function humanActionFromRecord(record: Record<string, unknown>, fallbackUrl: string | undefined, stepIndex: number): GuiAgentTraceStep | null {
  const apiName = typeof record.apiName === "string" ? record.apiName : typeof record.method === "string" ? record.method : "";
  const params = typeof record.params === "object" && record.params ? (record.params as Record<string, unknown>) : {};
  if (!/click|fill|type|press|goto|navigate|select|scroll/i.test(apiName)) return null;
  const selector = typeof params.selector === "string" ? params.selector : undefined;
  const url = typeof params.url === "string" ? params.url : fallbackUrl;
  const publicUrl = publicExcerpt(url, 140);
  const actionType = parseActionType(apiName);
  return {
    stepIndex,
    observationType: "mixed",
    observationSummary: publicUrl ? `Human browser action near ${publicUrl}` : "Human Playwright browser action.",
    actionType,
    target: {
      label: selector ? stripHtml(selector).slice(0, 96) : `browser ${actionType} ${stepIndex}`,
      domSelector: selector,
      bbox: fallbackBbox(stepIndex),
    },
    inputText: typeof params.text === "string" ? params.text : typeof params.value === "string" ? params.value : undefined,
    structuredRationale: "Observable human browser interaction parsed from Playwright trace.",
    confidence: selector ? 0.55 : 0.32,
    stateAfter: publicUrl ? `page:${publicUrl}` : `human-step-${stepIndex}`,
    url,
    adapterConfidence: selector ? "medium" : "low",
    sourceWarnings: selector ? undefined : ["semantic target label unavailable; fallback browser action target generated"],
  };
}

async function parseHumanZip({
  filePath,
  collection,
  options,
}: {
  filePath: string;
  collection: string;
  options: DatasetImportOptions;
}): Promise<GuiAgentTask> {
  const benchmark = inferBenchmark(collection);
  const site = inferSite(filePath, benchmark);
  const taskNumericId = inferTaskNumericId(filePath);
  const taskId = taskIdFor(benchmark, taskNumericId, site);
  const relativePath = path.relative(options.rootDir, filePath).replace(/\\/g, "/");
  const zipEntries = listZipEntries(filePath);
  const traceFile = zipEntries.find((entry) => /\.trace$/i.test(entry));
  const imageFiles = zipEntries.filter((entry) => /\.(png|jpe?g)$/i.test(entry));
  const traceText = traceFile ? readZipEntryText(filePath, traceFile) ?? "" : "";
  const visualFrames = extractHumanVisualFrames(traceText, zipEntries);
  let currentUrl: string | undefined;
  const steps: GuiAgentTraceStep[] = [];
  const actionTimes: Array<number | undefined> = [];
  if (traceText) {
    for (const line of traceText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const params = typeof record.params === "object" && record.params ? (record.params as Record<string, unknown>) : {};
        const navigatedUrl = typeof params.url === "string" ? params.url : undefined;
        if (record.class === "Frame" && record.method === "navigated" && navigatedUrl) currentUrl = navigatedUrl;
        const actionStep = humanActionFromRecord(record, currentUrl, steps.length + 1);
        if (actionStep) {
          const actionTime =
            typeof record.endTime === "number"
              ? record.endTime
              : typeof record.startTime === "number"
                ? record.startTime
                : typeof record.time === "number"
                  ? record.time
                  : undefined;
          steps.push(actionStep);
          actionTimes.push(actionTime);
        }
      } catch {
        // Ignore malformed trace lines.
      }
      if (steps.length >= 80) break;
    }
  }
  if (steps.length === 0) {
    steps.push({
      stepIndex: 1,
      observationType: "mixed",
      observationSummary: "Human Playwright trace detected; semantic action extraction unavailable.",
      actionType: "wait",
      target: { label: "human trace playback", bbox: fallbackBbox(1) },
      structuredRationale: "Observable trace file detected; action extraction unavailable.",
      confidence: 0.2,
      stateAfter: "human_trace_loaded",
      sourceRef: relativePath,
      adapterConfidence: "low",
      sourceWarnings: ["no semantic Playwright action recovered from trace payload"],
    });
  }
  const zipArchive = options.writeThumbnails ? await JSZip.loadAsync(await fs.readFile(filePath)) : undefined;
  const usedFrames = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (index >= (options.thumbnailLimitPerRun ?? 16)) break;
    const frame = chooseHumanFrame(visualFrames, actionTimes[index], step.stepIndex, steps.length, usedFrames);
    if (!frame) continue;
    usedFrames.add(frame.sha1);
    step.visualFrameAvailable = true;
    step.screenshotRef = `zip:${relativePath}:${frame.entry}`;
    step.visualFingerprint = `sha1:${frame.sha1}`;
    if (options.writeThumbnails) {
      const outputRelative = path.join(
        "trajectory-thumbnails",
        `${sanitizeId(`${collection}-${site ?? "site"}-${taskNumericId}-${index + 1}-${hashShort(frame.sha1)}`)}.webp`,
      );
      const outputPath = path.resolve("public", outputRelative);
      const zipFile = zipArchive?.file(frame.entry);
      const bytes = zipFile ? Buffer.from(await zipFile.async("uint8array")) : readZipEntryBytes(filePath, frame.entry);
      if (!bytes) continue;
      step.visualStateSignature = await visualStateSignatureFromBuffer(bytes);
      if (await fileExists(outputPath)) {
        step.thumbnailRef = `/${outputRelative.replace(/\\/g, "/")}`;
        continue;
      }
      const thumbnail = await sharp(bytes).resize({ width: thumbnailWidth, withoutEnlargement: true }).webp({ quality: thumbnailQuality }).toBuffer();
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, thumbnail);
      step.thumbnailRef = `/${outputRelative.replace(/\\/g, "/")}`;
    }
    step.sourceRef = `${relativePath}#step-${step.stepIndex}`;
  }
  const sourceCollection = collection;
  const trace: GuiAgentTrace = {
    traceId: `${taskId}-${sanitizeId(sourceCollection)}-human`,
    agentId: "human-reference",
    agentKind: "human",
    modelId: "human-reference",
    taskId,
    steps,
    sourceType: "playwright_human_trace",
    sourceLabel: sourceCollection,
    sourceWarnings: ["Human Playwright trace parsing is best-effort; semantic targets may be low-confidence."],
    benchmark,
    site,
    sourceCollection,
    actorType: "human",
    observationMode: "mixed",
    outcome: "unknown",
    sourcePath: relativePath,
  };
  return {
    taskId,
    title: `${benchmark} human task ${site ? `${site} ` : ""}${taskNumericId}`,
    instruction: `Inspect human trajectory for ${benchmark} task ${taskNumericId}.`,
    domain: site ? `${benchmark} / ${site}` : benchmark,
    startUrl: steps.find((step) => step.url)?.url ?? `offline://${benchmark}/human/${taskNumericId}`,
    successCriteria: "Use as a human reference trajectory against model runs of the same task.",
    riskTags: [benchmark, site ?? "site-unknown", "human", "outcome-unknown"],
    textState: "Human browser actions are parsed from Playwright trace events when possible.",
    visualState: visualFrames.length > 0 ? "Playwright screencast frames are aligned to observable actions." : "No screenshot resource was detected.",
    screenshotSize: defaultScreenshotSize,
    traces: [trace],
    sourceType: "playwright_human_trace",
    sourceLabel: sourceCollection,
    benchmark,
    taskNumericId,
    site,
    sourceCollection,
    sourcePath: relativePath,
    sourceFiles: [relativePath],
  };
}

function mergeTask(tasksById: Map<string, GuiAgentTask>, incoming: GuiAgentTask) {
  const current = tasksById.get(incoming.taskId);
  if (!current) {
    tasksById.set(incoming.taskId, incoming);
    return;
  }
  const traces = new Map(current.traces.map((trace) => [trace.traceId, trace]));
  incoming.traces.forEach((trace) => traces.set(trace.traceId, trace));
  const incomingHasIntent = isInformativeInstruction(incoming.instruction);
  const currentHasIntent = isInformativeInstruction(current.instruction);
  const preferred = incomingHasIntent && !currentHasIntent ? incoming : current;
  tasksById.set(incoming.taskId, {
    ...current,
    title: preferred.title,
    instruction: preferred.instruction,
    successCriteria: preferred.successCriteria || current.successCriteria,
    textState: preferred.textState || current.textState,
    visualState: preferred.visualState || current.visualState,
    traces: [...traces.values()],
    riskTags: [...new Set([...current.riskTags, ...incoming.riskTags])],
  });
}

export async function importDatasetTrajectories(options: DatasetImportOptions): Promise<{ tasks: GuiAgentTask[]; audit: DatasetAuditSummary }> {
  const rootDir = path.resolve(options.rootDir);
  const topEntries = await fs.readdir(rootDir, { withFileTypes: true });
  const collections = topEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !options.collectionFilter || name.toLowerCase().includes(options.collectionFilter.toLowerCase()));
  const tasksById = new Map<string, GuiAgentTask>();
  const warnings: string[] = [];
  const collectionAudits: DatasetAuditSummary["collections"] = [];
  for (const collection of collections) {
    const collectionRoot = path.join(rootDir, collection);
    const actorType = inferActorType(collection);
    progressLog(options, `[dataset] scanning ${collection}`);
    const allFiles = await listFilesRecursive(collectionRoot, (dir) => actorType === "human" && /\.trace$/i.test(path.basename(dir)));
    const benchmark = inferBenchmark(collection);
    const renderFiles = allFiles.filter((file) => /render_.*\.html$/i.test(path.basename(file)));
    const mergeLogs = allFiles.filter((file) => /merge[d]?_log\.txt$/i.test(path.basename(file)));
    const traceZips = allFiles.filter((file) => /\.zip$/i.test(file) && (actorType === "human" || /human|trace/i.test(file)));
    const mergeLog = await parseMergeLogs(mergeLogs);
    const beforeTaskCount = tasksById.size;
    let parsedRunCount = 0;
    let parsedStepCount = 0;
    const limitedRenderFiles = options.maxTasksPerCollection ? renderFiles.slice(0, options.maxTasksPerCollection) : renderFiles;
    for (const renderFile of limitedRenderFiles) {
      progressLog(options, `[dataset] parsing render ${path.relative(rootDir, renderFile)}`);
      const task = await parseRenderFile({ filePath: renderFile, collection, collectionRoot, mergeLog, options });
      parsedRunCount += task.traces.length;
      parsedStepCount += task.traces.reduce((sum, trace) => sum + trace.steps.length, 0);
      mergeTask(tasksById, task);
    }
    const limitedTraceZips = options.maxTasksPerCollection ? traceZips.slice(0, options.maxTasksPerCollection) : traceZips;
    for (const traceZip of limitedTraceZips) {
      try {
        progressLog(options, `[dataset] parsing human zip ${path.relative(rootDir, traceZip)}`);
        const task = await parseHumanZip({ filePath: traceZip, collection, options });
        parsedRunCount += task.traces.length;
        parsedStepCount += task.traces.reduce((sum, trace) => sum + trace.steps.length, 0);
        mergeTask(tasksById, task);
      } catch (error) {
        warnings.push(`${path.relative(rootDir, traceZip)}: ${error instanceof Error ? error.message : "human trace parse failed"}`);
      }
    }
    collectionAudits.push({
      name: collection,
      benchmark,
      actorType,
      renderHtmlCount: renderFiles.length,
      mergeLogCount: mergeLogs.length,
      traceZipCount: traceZips.length,
      parsedTaskCount: tasksById.size - beforeTaskCount,
      parsedRunCount,
      parsedStepCount,
    });
  }
  const tasks = [...tasksById.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const audit: DatasetAuditSummary = {
    generatedAt: new Date().toISOString(),
    rootDir,
    collectionCount: collections.length,
    collections: collectionAudits,
    taskCount: tasks.length,
    comparableTaskCount: tasks.filter((task) => task.traces.length >= 2).length,
    runCount: tasks.reduce((sum, task) => sum + task.traces.length, 0),
    stepCount: tasks.reduce((sum, task) => sum + task.traces.reduce((stepSum, trace) => stepSum + trace.steps.length, 0), 0),
    boundary: [
      "Dataset trajectories are offline observable WebArena/VisualWebArena artifacts.",
      "Raw model predictions are not analyzed as private reasoning.",
      "Human Playwright traces are parsed best-effort and may have low-confidence semantic targets.",
      "Large original archives are not persisted by default; normalized steps and screenshot references are used.",
    ],
    warnings,
  };
  return { tasks, audit };
}
