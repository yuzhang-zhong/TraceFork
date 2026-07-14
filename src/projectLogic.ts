import type {
  GuiActionAtom,
  GuiAgentTask,
  GuiAgentTrace,
  GuiAgentTraceStep,
  GuiAlignmentPair,
  GuiCanonicalState,
  GuiDivergenceRecord,
  GuiEvidenceModality,
  GuiRejoinRecord,
  GuiTraceAnalysis,
  GuiTraceGraph,
  GuiTraceMetrics,
  GuiTraceStepComparison,
  GuiUIEntity,
} from "./projectTypes.js";

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function bboxCenter(step: GuiAgentTraceStep | null): [number, number] | null {
  if (!step) return null;
  if (!Array.isArray(step.target.bbox) || step.target.bbox.length !== 4) return null;
  const [x, y, width, height] = step.target.bbox;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return [x + width / 2, y + height / 2];
}

function normalizedTargetLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function elementIdFromLabel(value: string): number | null {
  const match = normalizedTargetLabel(value).match(/\belement\s+([0-9]+)\b/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

function observedElementLabel(step: GuiAgentTraceStep | null | undefined): string | undefined {
  if (!step) return undefined;
  const id = elementIdFromLabel(step.target.label);
  if (id === null) return undefined;
  const compactObservation = step.observationSummary.replace(/\s+/g, " ");
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[${escapedId}\\]\\s*\\[[A-Z]+\\]\\s*\\[([^\\]]{1,140})\\]`, "i");
  const label = compactObservation.match(pattern)?.[1]?.replace(/\s+/g, " ").trim();
  if (!label || /^(url|http|https|local origin|local host|none|null|undefined)$/i.test(label)) return undefined;
  return normalizedTargetLabel(label).length > 2 ? label : undefined;
}

function effectiveTargetLabel(step: GuiAgentTraceStep | null | undefined): string {
  if (!step) return "";
  return observedElementLabel(step) ?? step.target.label;
}

function hashDistance(a: string, b: string): number {
  const left = stableHash(a) % 997;
  const right = stableHash(b) % 997;
  return Math.abs(left - right) / 996;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokenContainmentSimilarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  return intersection / Math.min(aTokens.size, bTokens.size);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeStateText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s"'<>]+/g, " ")
    .replace(/\b(?:file|embedded|zip):[^\s"'<>]+/g, " ")
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?/g, " ")
    .replace(/https?:\/\/[^/\s"'<>]+/g, " ")
    .replace(/[_/\\#?&=:.+-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function embeddingVector(value: string): number[] {
  const normalized = normalizeStateText(value);
  const dimensions = 96;
  const vector = Array.from({ length: dimensions }, () => 0);
  if (!normalized) return vector;
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 1);
  const features = new Map<string, number>();
  tokens.forEach((token) => {
    features.set(`w:${token}`, (features.get(`w:${token}`) ?? 0) + 1);
    for (let index = 0; index < token.length - 2; index += 1) {
      const gram = token.slice(index, index + 3);
      features.set(`g:${gram}`, (features.get(`g:${gram}`) ?? 0) + 0.35);
    }
  });
  [...features.entries()].forEach(([feature, weight]) => {
    const hash = stableHash(feature);
    const index = hash % dimensions;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign * Math.log1p(weight);
  });
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item ** 2, 0));
  return norm === 0 ? vector : vector.map((item) => item / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return clamp01((dot + 1) / 2);
}

function stateTextFor(step: GuiAgentTraceStep | null): string {
  if (!step) return "";
  return [step.stateAfter, step.observationSummary, effectiveTargetLabel(step), step.inputText, step.actionType].join(" ");
}

function missingCounterpartDistance(step: GuiAgentTraceStep | null, salt: string, base: number, spread: number): number {
  if (!step) return 1;
  const signature = [
    salt,
    step.stepIndex,
    step.actionType,
    step.target.label,
    step.stateAfter,
    step.observationSummary,
    step.target.bbox?.join(",") ?? "",
  ].join("|");
  return clamp01(base + ((stableHash(signature) % 1000) / 999) * spread);
}

function stateSemanticDistance(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): number {
  if (!textStep || !visionStep) return missingCounterpartDistance(textStep ?? visionStep, "missing-state", 0.6, 0.34);
  if (textStep.stateAfter === visionStep.stateAfter && textStep.observationSummary === visionStep.observationSummary) return 0;
  const lexicalSimilarity = jaccardSimilarity(stateTextFor(textStep), stateTextFor(visionStep));
  const embeddingSimilarity = cosineSimilarity(embeddingVector(stateTextFor(textStep)), embeddingVector(stateTextFor(visionStep)));
  return clamp01(1 - (0.68 * embeddingSimilarity + 0.32 * lexicalSimilarity));
}

function targetElementDifference(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): number {
  if (!textStep || !visionStep) return missingCounterpartDistance(textStep ?? visionStep, "missing-target", 0.58, 0.34);
  if (textStep.target.domSelector && textStep.target.domSelector === visionStep.target.domSelector) return 0;
  const textLabel = normalizedTargetLabel(effectiveTargetLabel(textStep));
  const visionLabel = normalizedTargetLabel(effectiveTargetLabel(visionStep));
  if (textLabel === visionLabel) return 0;
  if (tokenContainmentSimilarity(textLabel, visionLabel) >= 0.98 && Math.min(textLabel.length, visionLabel.length) >= 4) return 0.08;
  const textElementId = elementIdFromLabel(textStep.target.label);
  const visionElementId = elementIdFromLabel(visionStep.target.label);
  if (textElementId !== null && visionElementId !== null) {
    return clamp01(0.28 + Math.min(Math.abs(textElementId - visionElementId) / 42, 1) * 0.62);
  }
  if (
    (textLabel.includes("shipping") && visionLabel.includes("billing")) ||
    (textLabel.includes("billing") && visionLabel.includes("shipping"))
  ) {
    return 1;
  }
  const labelSimilarity = jaccardSimilarity(textLabel, visionLabel);
  const embeddingSimilarity = cosineSimilarity(embeddingVector(textLabel), embeddingVector(visionLabel));
  const semanticSimilarity = Math.max(labelSimilarity, embeddingSimilarity);
  return clamp01(0.12 + (1 - semanticSimilarity) * 0.78 + hashDistance(textLabel, visionLabel) * 0.1);
}

function screenDistance(
  textStep: GuiAgentTraceStep | null,
  visionStep: GuiAgentTraceStep | null,
  screenshotSize: GuiAgentTask["screenshotSize"],
): number {
  const textCenter = bboxCenter(textStep);
  const visionCenter = bboxCenter(visionStep);
  if ((!textStep || !visionStep) && (textCenter || visionCenter)) {
    return missingCounterpartDistance(textStep ?? visionStep, "missing-screen", 0.42, 0.4);
  }
  if (!textCenter || !visionCenter) return 1;
  const dx = textCenter[0] - visionCenter[0];
  const dy = textCenter[1] - visionCenter[1];
  const diagonal = Math.sqrt(screenshotSize.width ** 2 + screenshotSize.height ** 2);
  return clamp01(Math.sqrt(dx ** 2 + dy ** 2) / diagonal);
}

function actionOpFromStep(step: GuiAgentTraceStep): GuiActionAtom["op"] {
  const target = normalizedTargetLabel(effectiveTargetLabel(step));
  if (step.actionType === "click" && /\b(submit|confirm|send|pay|purchase|place order|save)\b/i.test(target)) return "submit";
  return step.actionType;
}

function bboxGridCell(bbox: [number, number, number, number] | undefined, screenshotSize: GuiAgentTask["screenshotSize"]): string {
  if (!bbox) return "no-bbox";
  const [x, y, width, height] = bbox;
  const x2 = x + width;
  const y2 = y + height;
  return [
    Math.round((x / Math.max(1, screenshotSize.width)) * 20),
    Math.round((y / Math.max(1, screenshotSize.height)) * 20),
    Math.round((x2 / Math.max(1, screenshotSize.width)) * 20),
    Math.round((y2 / Math.max(1, screenshotSize.height)) * 20),
  ].join(":");
}

function entityRoleForStep(step: GuiAgentTraceStep): string {
  if (step.target.domSelector?.includes("input") || step.actionType === "type") return "textbox";
  if (step.actionType === "select") return "select";
  if (step.actionType === "navigate") return "page";
  if (step.actionType === "wait") return "state";
  return "button";
}

function modalitySourcesForStep(step: GuiAgentTraceStep): Array<"dom" | "a11y" | "ocr" | "vision"> {
  const sources = new Set<"dom" | "a11y" | "ocr" | "vision">();
  if (step.observationType === "dom" || step.observationType === "mixed" || step.target.domSelector) sources.add("dom");
  if (/\[[A-Z]+\]|\b(role|button|link|textbox|menuitem)\b/i.test(step.observationSummary)) sources.add("a11y");
  if (/\bOCR\b|text detected|image text/i.test(step.observationSummary)) sources.add("ocr");
  if (step.observationType === "screenshot" || step.observationType === "mixed" || step.thumbnailRef || step.screenshotRef || step.visualFingerprint) sources.add("vision");
  return [...sources];
}

function uiEntityForStep(step: GuiAgentTraceStep, screenshotSize: GuiAgentTask["screenshotSize"]) {
  const label = effectiveTargetLabel(step);
  const text = normalizedTargetLabel(label);
  const role = entityRoleForStep(step);
  const grid = bboxGridCell(step.target.bbox, screenshotSize);
  const entityId = `ui-${stableHash([text, role, grid, step.target.domSelector ?? "", step.visualFingerprint ?? ""].join("|")).toString(36)}`;
  return {
    entityId,
    text: label,
    role,
    bbox: step.target.bbox,
    domRef: step.target.domSelector,
    visualRef: step.visualFingerprint ?? step.thumbnailRef ?? step.screenshotRef,
    isClickable: step.actionType === "click" || step.actionType === "select" || actionOpFromStep(step) === "submit",
    modalitySources: modalitySourcesForStep(step),
  };
}

function uiEntitiesForStep(step: GuiAgentTraceStep | null, screenshotSize: GuiAgentTask["screenshotSize"]) {
  if (!step) return [];
  return step.uiEntities?.length ? step.uiEntities : [uiEntityForStep(step, screenshotSize)];
}

function actionAtomForStep(step: GuiAgentTraceStep | null, screenshotSize: GuiAgentTask["screenshotSize"]): GuiActionAtom | undefined {
  if (!step) return undefined;
  if (step.normalizedAction) return step.normalizedAction;
  const entity = uiEntitiesForStep(step, screenshotSize)[0];
  return {
    op: actionOpFromStep(step),
    targetEntityId: entity?.entityId,
    targetText: effectiveTargetLabel(step),
    targetBbox: step.target.bbox,
    value: step.inputText,
    intentLabel: shortIntentLabel(step),
    confidence: step.confidence,
  };
}

function shortIntentLabel(step: GuiAgentTraceStep): string {
  const text = normalizeStateText([step.actionType, step.inputText, effectiveTargetLabel(step), step.structuredRationale].filter(Boolean).join(" "));
  return text.split(/\s+/).slice(0, 8).join(" ");
}

function routeFromStep(step: GuiAgentTraceStep | null): string {
  const raw = step?.url ?? step?.stateAfter ?? "";
  return canonicalUrl(raw).replace(/^https?:\/\//, "").split(/[?#]/)[0] ?? "";
}

function canonicalStateForStep(step: GuiAgentTraceStep | null, task: GuiAgentTask): GuiCanonicalState {
  if (!step) {
    return {
      signature: "missing-state",
      entityKeys: [],
      ocrTextSet: [],
      layoutKeys: [],
    };
  }
  if (step.stateSignature) {
    return {
      signature: step.stateSignature,
      urlRoute: routeFromStep(step),
      entityKeys: uiEntitiesForStep(step, task.screenshotSize).map((entity) => `${normalizedTargetLabel(entity.text ?? "")}:${entity.role ?? ""}`),
      ocrTextSet: [],
      layoutKeys: uiEntitiesForStep(step, task.screenshotSize).map((entity) => bboxGridCell(entity.bbox, task.screenshotSize)),
      visualFingerprint: step.visualFingerprint,
      visualStateSignature: step.visualStateSignature,
    };
  }
  const entities = uiEntitiesForStep(step, task.screenshotSize);
  const entityKeys = entities.map((entity) =>
    [
      normalizedTargetLabel(entity.text ?? ""),
      entity.role ?? "",
      bboxGridCell(entity.bbox, task.screenshotSize),
      entity.isClickable ? "clickable" : "static",
    ].join(":"),
  );
  const ocrTextSet = normalizeStateText(step.observationSummary)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 32);
  const layoutKeys = entities.map((entity) => bboxGridCell(entity.bbox, task.screenshotSize));
  const urlRoute = routeFromStep(step);
  const signature = `state-${stableHash([task.domain, urlRoute, step.visualFingerprint ?? "", step.visualStateSignature ?? "", ...entityKeys.sort(), ...ocrTextSet.sort()].join("|")).toString(36)}`;
  return {
    signature,
    urlRoute,
    appName: task.benchmark ?? task.domain,
    windowTitle: task.site ?? task.domain,
    entityKeys,
    ocrTextSet,
    layoutKeys,
    visualFingerprint: step.visualFingerprint,
    visualStateSignature: step.visualStateSignature,
  };
}

function setSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}

function canonicalStateSimilarity(a: GuiCanonicalState, b: GuiCanonicalState): number {
  if (a.signature === b.signature) return 1;
  const entity = setSimilarity(a.entityKeys, b.entityKeys);
  const ocr = setSimilarity(a.ocrTextSet, b.ocrTextSet);
  const url = a.urlRoute && b.urlRoute ? (a.urlRoute === b.urlRoute ? 1 : jaccardSimilarity(a.urlRoute, b.urlRoute)) : 0.4;
  const visual =
    a.visualFingerprint && b.visualFingerprint && a.visualFingerprint === b.visualFingerprint
      ? 1
      : Math.max(visualStateSignatureSimilarity(a.visualStateSignature, b.visualStateSignature), a.visualFingerprint || b.visualFingerprint ? 0 : 0.35);
  const layout = setSimilarity(a.layoutKeys, b.layoutKeys);
  return roundThree(0.3 * entity + 0.25 * ocr + 0.2 * url + 0.15 * visual + 0.1 * layout);
}

function bboxIou(a: [number, number, number, number] | undefined, b: [number, number, number, number] | undefined): number {
  if (!a || !b) return 0;
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = aw * ah + bw * bh - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function actionValueSimilarity(a: string | undefined, b: string | undefined): number {
  const left = normalizeStateText(a ?? "");
  const right = normalizeStateText(b ?? "");
  if (!left && !right) return 1;
  if (!left || !right) return 0.35;
  if (left === right) return 1;
  const lexical = jaccardSimilarity(left, right);
  const embedding = cosineSimilarity(embeddingVector(left), embeddingVector(right));
  const contains = tokenContainmentSimilarity(left, right);
  const longEncodedInput =
    (left.match(/\b\d+\b/g)?.length ?? 0) >= 6 ||
    (right.match(/\b\d+\b/g)?.length ?? 0) >= 6 ||
    Math.max(left.length, right.length) >= 24;
  if (longEncodedInput) return roundThree(Math.min(0.82, 0.55 * lexical + 0.3 * contains + 0.15 * embedding));
  return roundThree(Math.max(lexical, 0.62 * embedding + 0.26 * lexical + 0.12 * contains));
}

function hasActionValueConflict(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): boolean {
  if (!textStep || !visionStep) return false;
  if (textStep.actionType !== "type" && visionStep.actionType !== "type" && !textStep.inputText && !visionStep.inputText) return false;
  const left = normalizeStateText(textStep.inputText ?? "");
  const right = normalizeStateText(visionStep.inputText ?? "");
  if (!left || !right || left === right) return false;
  return actionValueSimilarity(left, right) < 0.9;
}

function actionAtomSimilarity(a: GuiActionAtom | undefined, b: GuiActionAtom | undefined): number {
  if (!a || !b) return 0;
  const opMatch = a.op === b.op ? 1 : new Set(["navigate:wait", "wait:navigate", "click:select", "select:click"]).has(`${a.op}:${b.op}`) ? 0.45 : 0;
  const entityMatch = a.targetEntityId && b.targetEntityId && a.targetEntityId === b.targetEntityId ? 1 : 0;
  const targetText = jaccardSimilarity(normalizedTargetLabel(a.targetText ?? ""), normalizedTargetLabel(b.targetText ?? ""));
  const targetBox = bboxIou(a.targetBbox, b.targetBbox);
  const value = actionValueSimilarity(a.value, b.value);
  const valueWeight = a.op === "type" || b.op === "type" || a.value || b.value ? 0.32 : 0.08;
  const base = (0.4 - valueWeight * 0.35) * opMatch + 0.31 * entityMatch + 0.17 * targetText + 0.12 * targetBox + valueWeight * value;
  return roundThree(clamp01(base));
}

function actionSimilarity(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): number {
  if (!textStep || !visionStep) return 0;
  if (textStep.actionType === visionStep.actionType) {
    if (textStep.actionType === "type" || textStep.inputText || visionStep.inputText) {
      return roundThree(0.28 + 0.72 * actionValueSimilarity(textStep.inputText, visionStep.inputText));
    }
    return 1;
  }
  const weakPairs = new Set(["navigate:wait", "wait:navigate", "click:select", "select:click", "type:select", "select:type"]);
  return weakPairs.has(`${textStep.actionType}:${visionStep.actionType}`) ? 0.55 : 0;
}

function canonicalUrl(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/^url:/i, "")
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/\s"'<>]*\.local)(:\d+)?/gi, "[local]")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function visualSimilarity(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): number {
  if (!textStep || !visionStep) return 0;
  if (textStep.visualFingerprint && textStep.visualFingerprint === visionStep.visualFingerprint) return 1;
  if (textStep.screenshotRef && textStep.screenshotRef === visionStep.screenshotRef) return 0.95;
  if (textStep.thumbnailRef && textStep.thumbnailRef === visionStep.thumbnailRef) return 0.95;
  const visualSignatureScore = visualStateSignatureSimilarity(textStep.visualStateSignature, visionStep.visualStateSignature);
  if (visualSignatureScore >= 0.86) return 0.88;
  if (visualSignatureScore >= 0.74) return 0.72;
  if (visualSignatureScore >= 0.62) return Math.max(0.55, visualSignatureScore * 0.8);
  const textUrl = canonicalUrl(textStep.url ?? textStep.stateAfter);
  const visionUrl = canonicalUrl(visionStep.url ?? visionStep.stateAfter);
  if (textUrl && visionUrl && textUrl === visionUrl) return 0.72;
  return 0;
}

function visualStateSignatureSimilarity(left: string | undefined, right: string | undefined): number {
  const usableHash = (part: string) => /^[a-f0-9]{16}$/i.test(part) && !/^0{16}$/i.test(part) && !/^f{16}$/i.test(part);
  const leftParts = (left ?? "").split(/[;|,\s]+/).filter(usableHash);
  const rightParts = (right ?? "").split(/[;|,\s]+/).filter(usableHash);
  if (leftParts.length === 0 || rightParts.length === 0) return 0;
  let best = 0;
  for (const a of leftParts) {
    for (const b of rightParts) {
      best = Math.max(best, 1 - hammingHex64(a, b) / 64);
    }
  }
  return roundThree(clamp01(best));
}

function hammingHex64(left: string, right: string): number {
  let diff = 0n;
  try {
    diff = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  } catch {
    return 64;
  }
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

function hasComparableVisualFrame(step: GuiAgentTraceStep | null | undefined): boolean {
  return Boolean(step?.thumbnailRef || step?.screenshotRef || step?.visualFingerprint || step?.visualFrameAvailable);
}

function strongVisualMismatch(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): boolean {
  if (!textStep || !visionStep) return false;
  if (!hasComparableVisualFrame(textStep) || !hasComparableVisualFrame(visionStep)) return false;
  if (textStep.visualFingerprint && visionStep.visualFingerprint && textStep.visualFingerprint === visionStep.visualFingerprint) return false;
  return visualSimilarity(textStep, visionStep) < 0.18;
}

function isGenericBrowserTarget(step: GuiAgentTraceStep | null): boolean {
  if (!step) return false;
  const label = normalizedTargetLabel(effectiveTargetLabel(step));
  const summary = normalizeStateText(step.observationSummary);
  const genericLabel =
    /^element [0-9]+$/.test(label) ||
    /^browser (navigate|action|click|page) [0-9]+$/.test(label) ||
    /^observable target [0-9]+$/.test(label);
  return (
    step.actionType === "navigate" ||
    genericLabel ||
    (summary === "human browser action near web page" && genericLabel)
  );
}

function stepSemanticText(step: GuiAgentTraceStep | null | undefined): string {
  if (!step) return "";
  return normalizeStateText(
    [
      step.actionType,
      effectiveTargetLabel(step),
      step.inputText,
      step.stateAfter,
      step.observationSummary,
      step.structuredRationale,
      step.agentOutputExcerpt,
      routeFromStep(step),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function stepFailureSignal(step: GuiAgentTraceStep | null | undefined): number {
  if (!step) return 0;
  const text = normalizeStateText([step.actionType, effectiveTargetLabel(step), step.structuredRationale, step.agentOutputExcerpt, step.stateAfter].filter(Boolean).join(" "));
  let score = 0;
  if (/\b(early stop|same action|unable to|cannot|can not|could not|failed|failure|no matching|not found|do not have the ability)\b/.test(text)) score += 0.75;
  if (/\bstop\b/.test(text)) score += 0.35;
  if (/\b(required|need|would need|additional navigation|search functions)\b/.test(text) && /\b(unable|cannot|not found|required)\b/.test(text)) score += 0.25;
  return clamp01(score);
}

function isFailureStep(step: GuiAgentTraceStep | null | undefined): boolean {
  return stepFailureSignal(step) >= 0.65;
}

function isTerminalFailureStep(step: GuiAgentTraceStep | null | undefined, trace?: GuiAgentTrace): boolean {
  if (!step || !isFailureStep(step)) return false;
  if (trace?.outcome === "success") return false;
  const ordered = trace ? [...trace.steps].sort((a, b) => a.stepIndex - b.stepIndex) : [];
  const last = ordered[ordered.length - 1];
  const isLastKnownStep = !trace || last?.stepIndex === step.stepIndex;
  if (!isLastKnownStep) return false;
  const text = normalizeStateText([step.actionType, effectiveTargetLabel(step), step.structuredRationale, step.agentOutputExcerpt, step.stateAfter].filter(Boolean).join(" "));
  return /\b(early stop|same action|unable to|cannot|can not|could not|failed|failure|no matching|not found|do not have the ability)\b/.test(text);
}

function repeatedActionRunLength(steps: GuiAgentTraceStep[]): number {
  let longest = 0;
  let current = 0;
  let last = "";
  for (const step of steps) {
    const key = normalizeStateText([step.actionType, effectiveTargetLabel(step), step.inputText ?? ""].join(" "));
    current = key && key === last ? current + 1 : 1;
    longest = Math.max(longest, current);
    last = key;
  }
  return longest;
}

function inferredTraceOutcome(trace: GuiAgentTrace): "success" | "failed" | "unknown" {
  if (trace.outcome && trace.outcome !== "unknown") return trace.outcome;
  const ordered = [...trace.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const last = ordered[ordered.length - 1];
  if (isTerminalFailureStep(last, trace)) return "failed";
  if (repeatedActionRunLength(ordered) >= 4) return "failed";
  return "unknown";
}

function observableStepText(step: GuiAgentTraceStep | null | undefined): string {
  if (!step) return "";
  return normalizeStateText([step.actionType, effectiveTargetLabel(step), step.inputText, step.stateAfter, step.observationSummary, routeFromStep(step)].filter(Boolean).join(" "));
}

function informativeTargetText(step: GuiAgentTraceStep | null | undefined): string {
  if (!step) return "";
  const label = normalizedTargetLabel(effectiveTargetLabel(step));
  if (!label) return "";
  if (isGenericBrowserTarget(step)) return "";
  if (/^[0-9 ]+$/.test(label)) return "";
  if (/^observable target [0-9]+$/.test(label)) return "";
  if (/^(there are no listings|unable to complete|early stop|browser action)/.test(label)) return "";
  const tokens = [...tokenSet(label)].filter((token) => !["internal", "text", "role", "link", "name", "label", "has", "attr", "button"].includes(token));
  return tokens.length >= 1 ? tokens.join(" ") : "";
}

type SemanticPageClass = "home" | "search_input" | "listing_page" | "item_detail" | "filter_sort" | "unknown";

function targetIntentClass(step: GuiAgentTraceStep | null | undefined): "category" | "filter" | "product" | "search_input" | "generic" {
  if (!step) return "generic";
  const label = normalizedTargetLabel(effectiveTargetLabel(step));
  const text = normalizeStateText([effectiveTargetLabel(step), step.inputText, step.observationSummary].filter(Boolean).join(" "));
  if (!label || isGenericBrowserTarget(step)) return "generic";
  if (step.actionType === "type" || /\bplaceholder|search|looking for|what are you looking\b/.test(text)) return "search_input";
  if (/\b(newly listed|higher price|lower price|apply|price|min|max|sort|filter|page [0-9]+)\b/.test(text)) return "filter";
  if (/\b(beauty health|cell phones|rvs campers|rv campers|rvs|campers|category)\b/.test(text)) return "category";
  return "product";
}

function semanticPageClassForStep(
  step: GuiAgentTraceStep,
  previous: GuiAgentTraceStep | undefined,
  next: GuiAgentTraceStep | undefined,
): SemanticPageClass {
  const routeText = normalizeStateText([step.url, step.stateAfter, routeFromStep(step)].filter(Boolean).join(" "));
  const currentIntent = targetIntentClass(step);
  const previousIntent = targetIntentClass(previous);
  if (/\bpage item\b|\bitem id\b/.test(routeText)) return "item_detail";
  if (/\bpage search\b|\bscategory\b|\bspattern\b/.test(routeText)) return currentIntent === "filter" ? "filter_sort" : "listing_page";
  if (currentIntent === "search_input") return "search_input";
  if (currentIntent === "filter") return "filter_sort";
  if (currentIntent === "category") return "listing_page";
  if (step.actionType === "navigate" && previousIntent === "product") return "item_detail";
  if (step.actionType === "navigate" && (previousIntent === "category" || previousIntent === "filter" || previousIntent === "search_input")) return "listing_page";
  if (currentIntent === "product") return "item_detail";
  if (!previous && next && targetIntentClass(next) === "category") return "home";
  return "unknown";
}

export function classifyGuiTraceStepPageClass(
  step: GuiAgentTraceStep,
  previous?: GuiAgentTraceStep,
  next?: GuiAgentTraceStep,
): SemanticPageClass {
  return semanticPageClassForStep(step, previous, next);
}

function localTargetContext(steps: GuiAgentTraceStep[], index: number): string {
  return [steps[index - 1], steps[index], steps[index + 1]].map(informativeTargetText).filter(Boolean).join(" ");
}

function contextWindowText(steps: GuiAgentTraceStep[], index: number): string {
  const step = steps[index];
  const previous = steps[index - 1];
  const next = steps[index + 1];
  const generic = isGenericBrowserTarget(step);
  const parts = [observableStepText(step)];
  if (generic || step.actionType === "navigate" || step.actionType === "wait") {
    parts.push(observableStepText(previous));
  }
  if (generic || /^element [0-9]+$/.test(normalizedTargetLabel(effectiveTargetLabel(step)))) {
    parts.push(observableStepText(next));
  }
  return parts.join(" ");
}

function contextSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const lexical = jaccardSimilarity(a, b);
  const embedding = cosineSimilarity(embeddingVector(a), embeddingVector(b));
  return roundThree(Math.max(lexical, 0.72 * embedding + 0.28 * lexical));
}

function carriedActionForStep(
  step: GuiAgentTraceStep,
  previous: GuiAgentTraceStep | undefined,
  next: GuiAgentTraceStep | undefined,
  screenshotSize: GuiAgentTask["screenshotSize"],
): GuiActionAtom | undefined {
  const own = actionAtomForStep(step, screenshotSize);
  if (!previous || !isGenericBrowserTarget(step)) return own;
  const previousAction = actionAtomForStep(previous, screenshotSize);
  if (!previousAction || !["click", "select", "submit", "type"].includes(previousAction.op)) return own;
  const nextText = stepSemanticText(next);
  const carryText = stepSemanticText(previous);
  const currentText = stepSemanticText(step);
  const carriedIntent = [previousAction.intentLabel, carryText, currentText, nextText].filter(Boolean).join(" ");
  return {
    ...previousAction,
    intentLabel: normalizeStateText(carriedIntent).split(/\s+/).slice(0, 16).join(" "),
    confidence: Math.min(previousAction.confidence ?? 0.5, step.confidence),
  };
}

function nearOverlapSimilarity(
  textStep: GuiAgentTraceStep | null,
  visionStep: GuiAgentTraceStep | null,
  screenshotSize: GuiAgentTask["screenshotSize"],
): number {
  if (!textStep || !visionStep) return 0;
  const action = actionSimilarity(textStep, visionStep);
  const target = 1 - targetElementDifference(textStep, visionStep);
  const state = 1 - stateSemanticDistance(textStep, visionStep);
  const visual = visualSimilarity(textStep, visionStep);
  const screen = 1 - screenDistance(textStep, visionStep, screenshotSize);
  const visualActionAnchor = visual >= 0.95 && action >= 0.55 ? 0.96 : 0;
  const stateActionAnchor = state >= 0.86 && action >= 0.8 ? 0.88 : 0;
  const weighted = 0.34 * state + 0.24 * action + 0.2 * target + 0.14 * visual + 0.08 * screen;
  return roundThree(Math.max(weighted, visualActionAnchor, stateActionAnchor));
}

function isOffsetOverlapCandidate(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): boolean {
  if (!textStep || !visionStep) return false;
  const action = actionSimilarity(textStep, visionStep);
  const visual = visualSimilarity(textStep, visionStep);
  if (visual >= 0.95 && action >= 0.55) return true;
  return action >= 0.8 && targetElementDifference(textStep, visionStep) <= 0.12 && stateSemanticDistance(textStep, visionStep) <= 0.22;
}

type TraceAlignmentRow = {
  textStep: GuiAgentTraceStep | null;
  visionStep: GuiAgentTraceStep | null;
  alignmentCost: number;
  contextSimilarity: number;
  relation: GuiAlignmentPair["relation"];
};

type NormalizedStepView = {
  step: GuiAgentTraceStep;
  action: GuiActionAtom | undefined;
  state: GuiCanonicalState;
  previousState: GuiCanonicalState;
  nextState: GuiCanonicalState;
  phaseLabel: string;
  contextText: string;
  targetContextText: string;
  pageClass: SemanticPageClass;
  genericTarget: boolean;
  hasVisualFrame: boolean;
};

function phaseLabelForStep(step: GuiAgentTraceStep, state: GuiCanonicalState): string {
  const route = state.urlRoute || "no-route";
  const op = actionOpFromStep(step);
  const mode = step.visualFingerprint ? "visual" : step.observationType;
  return `${route}|${op === "navigate" ? "navigation" : "interaction"}|${mode}`;
}

function normalizeTraceViews(trace: GuiAgentTrace, task: GuiAgentTask): NormalizedStepView[] {
  const sorted = [...trace.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const skipped = new Set<GuiAgentTraceStep>();
  sorted.forEach((step, index) => {
    const next = sorted[index + 1];
    if (targetIntentClass(step) === "product" && next?.actionType === "navigate" && isGenericBrowserTarget(next)) {
      skipped.add(step);
    }
  });
  const ordered = sorted.filter((step, index) => {
    if (index === 0 && sorted.length > 1 && isGenericBrowserTarget(step) && step.actionType === "navigate") return false;
    return !skipped.has(step);
  });
  return ordered.map((step) => {
    const sourceIndex = sorted.indexOf(step);
    const previous = sorted[sourceIndex - 1];
    const next = sorted[sourceIndex + 1];
    const state = canonicalStateForStep(step, task);
    const previousState = canonicalStateForStep(previous ?? step, task);
    const nextState = canonicalStateForStep(next ?? step, task);
    return {
      step,
      action: carriedActionForStep(step, previous, next, task.screenshotSize),
      state,
      previousState,
      nextState,
      phaseLabel: phaseLabelForStep(step, state),
      contextText: contextWindowText(sorted, sourceIndex),
      targetContextText: localTargetContext(sorted, sourceIndex),
      pageClass: semanticPageClassForStep(step, previous, next),
      genericTarget: isGenericBrowserTarget(step),
      hasVisualFrame: Boolean(step.thumbnailRef || step.screenshotRef || step.visualFingerprint || step.visualFrameAvailable),
    };
  });
}

function pageClassSimilarity(a: SemanticPageClass, b: SemanticPageClass): number {
  if (a === b) return 1;
  if (a === "unknown" || b === "unknown") return 0.45;
  if (new Set([a, b]).has("filter_sort") && new Set([a, b]).has("listing_page")) return 0.68;
  if (new Set([a, b]).has("search_input") && new Set([a, b]).has("listing_page")) return 0.42;
  return 0;
}

function isNavigationPageClass(value: SemanticPageClass): boolean {
  return value === "listing_page" || value === "filter_sort" || value === "search_input" || value === "home";
}

function stepAlignmentContextSimilarity(a: NormalizedStepView, b: NormalizedStepView): number {
  const observable = contextSimilarity(a.contextText, b.contextText);
  const targetBridge = Math.max(
    contextSimilarity(a.targetContextText, b.targetContextText),
    tokenContainmentSimilarity(a.targetContextText, b.targetContextText),
  );
  const route = canonicalStateSimilarity(a.state, b.state);
  const previous = canonicalStateSimilarity(a.previousState, b.previousState);
  const actionIntent = jaccardSimilarity(a.action?.intentLabel ?? "", b.action?.intentLabel ?? "");
  const page = pageClassSimilarity(a.pageClass, b.pageClass);
  const transition = roundThree(0.38 * page + 0.34 * route + 0.18 * previous + 0.1 * actionIntent);
  const hasStrongTargetBridge = targetBridge >= 0.58 && Boolean(a.targetContextText) && Boolean(b.targetContextText);
  if ((a.genericTarget || b.genericTarget) && !hasStrongTargetBridge && page < 0.9 && route < 0.82) {
    return roundThree(clamp01(0.52 * observable + 0.28 * transition + 0.2 * targetBridge));
  }
  return roundThree(clamp01(Math.max(targetBridge, 0.52 * observable + 0.28 * transition + 0.2 * targetBridge)));
}

function stepAlignmentCost(a: NormalizedStepView, b: NormalizedStepView): number {
  const action = actionAtomSimilarity(a.action, b.action);
  const state = canonicalStateSimilarity(a.state, b.state);
  const transition = canonicalStateSimilarity(a.nextState, b.nextState);
  const intent = jaccardSimilarity(a.action?.intentLabel ?? "", b.action?.intentLabel ?? "");
  const context = stepAlignmentContextSimilarity(a, b);
  const page = pageClassSimilarity(a.pageClass, b.pageClass);
  const visualFrameMismatch = strongVisualMismatch(a.step, b.step);
  const targetBridge = Math.max(
    contextSimilarity(a.targetContextText, b.targetContextText),
    tokenContainmentSimilarity(a.targetContextText, b.targetContextText),
  );
  const phasePenalty = a.phaseLabel === b.phaseLabel ? 0 : state >= 0.85 ? 0.04 : 0.12;
  const pagePenalty = page >= 0.9 ? 0 : page >= 0.65 ? 0.08 : 0.24;
  const visualMismatchPenalty = visualFrameMismatch && targetBridge < 0.62 && context < 0.72 ? 0.18 : visualFrameMismatch ? 0.08 : 0;
  const valueMismatchPenalty = hasActionValueConflict(a.step, b.step) ? 0.2 : 0;
  const base = clamp01(
    0.24 * (1 - action) +
      0.2 * (1 - state) +
      0.13 * (1 - transition) +
      0.09 * (1 - intent) +
      0.18 * (1 - context) +
      0.16 * (1 - page) +
      phasePenalty +
      pagePenalty +
      visualMismatchPenalty +
      valueMismatchPenalty,
  );
  const navigationPageAnchor =
    page >= 0.9 && !visualFrameMismatch && isNavigationPageClass(a.pageClass) && isNavigationPageClass(b.pageClass) && a.hasVisualFrame && b.hasVisualFrame
      ? clamp01(0.28 + (1 - Math.max(context, page)) * 0.12)
      : 1;
  const itemPageAnchor =
    page >= 0.9 &&
    (!visualFrameMismatch || targetBridge >= 0.68) &&
    a.pageClass === "item_detail" &&
    b.pageClass === "item_detail" &&
    targetBridge >= 0.58 &&
    a.hasVisualFrame &&
    b.hasVisualFrame
      ? clamp01(0.24 + (1 - targetBridge) * 0.16)
      : 1;
  const contextualAnchor =
    context >= 0.52 &&
    page >= 0.68 &&
    (!visualFrameMismatch || context >= 0.76 || targetBridge >= 0.68) &&
    a.hasVisualFrame &&
    b.hasVisualFrame &&
    (a.genericTarget || b.genericTarget || action >= 0.45)
      ? clamp01(0.24 + (1 - context) * 0.2)
      : 1;
  const routeAnchor = state >= 0.72 && context >= 0.4 && !visualFrameMismatch ? clamp01(0.3 + (1 - state) * 0.22) : 1;
  return roundThree(Math.min(base, contextualAnchor, routeAnchor, navigationPageAnchor, itemPageAnchor));
}

function relationForCost(cost: number): GuiAlignmentPair["relation"] {
  if (cost < 0.3) return "matched";
  if (cost < 0.6) return "soft_mismatch";
  return "hard_divergence";
}

function isTerminalShortTrace(views: NormalizedStepView[]): boolean {
  if (views.length === 0 || views.length > 2) return false;
  return views.some((view) => isFailureStep(view.step)) || views.length === 1;
}

function forcedAlignmentRow(a: NormalizedStepView, b: NormalizedStepView): TraceAlignmentRow {
  const cost = stepAlignmentCost(a, b);
  const context = stepAlignmentContextSimilarity(a, b);
  return {
    textStep: a.step,
    visionStep: b.step,
    alignmentCost: cost,
    contextSimilarity: context,
    relation: relationForCost(cost),
  };
}

function rebalanceShortTerminalAlignment(
  rows: TraceAlignmentRow[],
  textViews: NormalizedStepView[],
  visionViews: NormalizedStepView[],
  gapPenalty: number,
): TraceAlignmentRow[] {
  if (rows.length === 0) return rows;
  const firstAlignedIndex = rows.findIndex((row) => row.textStep && row.visionStep);
  if (firstAlignedIndex <= 0) return rows;

  if (isTerminalShortTrace(textViews) && visionViews.length >= textViews.length + 3 && textViews[0] && visionViews[0]) {
    const aligned = forcedAlignmentRow(textViews[0], visionViews[0]);
    const remainingVision = visionViews.slice(1).map((view) => ({
      textStep: null,
      visionStep: view.step,
      alignmentCost: gapPenalty,
      contextSimilarity: 0,
      relation: "b_extra" as const,
    }));
    const remainingText = textViews.slice(1).map((view) => ({
      textStep: view.step,
      visionStep: null,
      alignmentCost: gapPenalty,
      contextSimilarity: 0,
      relation: "a_extra" as const,
    }));
    return [aligned, ...remainingText, ...remainingVision];
  }

  if (isTerminalShortTrace(visionViews) && textViews.length >= visionViews.length + 3 && textViews[0] && visionViews[0]) {
    const aligned = forcedAlignmentRow(textViews[0], visionViews[0]);
    const remainingText = textViews.slice(1).map((view) => ({
      textStep: view.step,
      visionStep: null,
      alignmentCost: gapPenalty,
      contextSimilarity: 0,
      relation: "a_extra" as const,
    }));
    const remainingVision = visionViews.slice(1).map((view) => ({
      textStep: null,
      visionStep: view.step,
      alignmentCost: gapPenalty,
      contextSimilarity: 0,
      relation: "b_extra" as const,
    }));
    return [aligned, ...remainingVision, ...remainingText];
  }

  return rows;
}

function alignTraceSteps(
  textTrace: GuiAgentTrace,
  visionTrace: GuiAgentTrace,
  task: GuiAgentTask,
): TraceAlignmentRow[] {
  const textViews = normalizeTraceViews(textTrace, task);
  const visionViews = normalizeTraceViews(visionTrace, task);
  const m = textViews.length;
  const n = visionViews.length;
  const gapPenalty = 0.78;
  const dp = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));
  type BackCell = { i: number; j: number; op: "align" | "a_extra" | "b_extra" } | null;
  const back: BackCell[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => null as BackCell));

  for (let i = 1; i <= m; i += 1) {
    dp[i][0] = dp[i - 1][0] + gapPenalty;
    back[i][0] = { i: i - 1, j: 0, op: "a_extra" };
  }
  for (let j = 1; j <= n; j += 1) {
    dp[0][j] = dp[0][j - 1] + gapPenalty;
    back[0][j] = { i: 0, j: j - 1, op: "b_extra" };
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = stepAlignmentCost(textViews[i - 1], visionViews[j - 1]);
      const alignCost = dp[i - 1][j - 1] + cost;
      const aExtraCost = dp[i - 1][j] + gapPenalty;
      const bExtraCost = dp[i][j - 1] + gapPenalty;
      const best = Math.min(alignCost, aExtraCost, bExtraCost);
      dp[i][j] = best;
      if (best === alignCost) {
        back[i][j] = { i: i - 1, j: j - 1, op: "align" };
      } else if (best === aExtraCost) {
        back[i][j] = { i: i - 1, j, op: "a_extra" };
      } else {
        back[i][j] = { i, j: j - 1, op: "b_extra" };
      }
    }
  }

  const rows: TraceAlignmentRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const move = back[i][j];
    if (!move) break;
    if (move.op === "align") {
      const cost = stepAlignmentCost(textViews[i - 1], visionViews[j - 1]);
      rows.push({
        textStep: textViews[i - 1].step,
        visionStep: visionViews[j - 1].step,
        alignmentCost: cost,
        contextSimilarity: stepAlignmentContextSimilarity(textViews[i - 1], visionViews[j - 1]),
        relation: relationForCost(cost),
      });
    } else if (move.op === "a_extra") {
      rows.push({
        textStep: textViews[i - 1].step,
        visionStep: null,
        alignmentCost: gapPenalty,
        contextSimilarity: 0,
        relation: "a_extra",
      });
    } else {
      rows.push({
        textStep: null,
        visionStep: visionViews[j - 1].step,
        alignmentCost: gapPenalty,
        contextSimilarity: 0,
        relation: "b_extra",
      });
    }
    i = move.i;
    j = move.j;
  }

  return rebalanceShortTerminalAlignment(rows.reverse(), textViews, visionViews, gapPenalty);
}

function convergenceScore(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null, priorDiverged: boolean): number {
  if (!textStep || !visionStep) return 0;
  const stateSimilarity = 1 - stateSemanticDistance(textStep, visionStep);
  const sameStateAfter = textStep.stateAfter === visionStep.stateAfter ? 1 : stateSimilarity >= 0.82 ? 0.8 : 0;
  const sameTargetElement = targetElementDifference(textStep, visionStep) === 0 ? 1 : 0;
  const actionSequenceSuffixSimilarity = textStep.actionType === visionStep.actionType ? 1 : 0;
  const rationaleSemanticSimilarity = jaccardSimilarity(textStep.structuredRationale, visionStep.structuredRationale);
  const successCriteriaProgressSimilarity = Math.max(sameStateAfter, textStep.target.label === visionStep.target.label ? 1 : stateSimilarity);
  const score =
    0.35 * stateSimilarity +
    0.25 * sameTargetElement +
    0.2 * actionSequenceSuffixSimilarity +
    0.1 * rationaleSemanticSimilarity +
    0.1 * successCriteriaProgressSimilarity;
  return roundOne(score);
}

function genericPairRequiresStrongerEvidence(textStep: GuiAgentTraceStep | null, visionStep: GuiAgentTraceStep | null): boolean {
  return Boolean(textStep && visionStep && (isGenericBrowserTarget(textStep) || isGenericBrowserTarget(visionStep)));
}

function comparisonHasRejoinEvidence(
  comparison: GuiTraceStepComparison,
  previous?: GuiTraceStepComparison,
  next?: GuiTraceStepComparison,
): boolean {
  const textStep = comparison.textStep;
  const visionStep = comparison.visionStep;
  if (!textStep || !visionStep) return false;
  const visual = visualSimilarity(textStep, visionStep);
  const action = actionSimilarity(textStep, visionStep);
  const targetClose = comparison.targetElementDiff <= 0.28;
  const genericTargetClose = comparison.targetElementDiff <= 0.18;
  const postDivergenceTargetClose = comparison.targetElementDiff <= 0.18;
  const targetAcceptableForConfirmedRejoin = comparison.targetElementDiff <= 0.34;
  const stateClose = comparison.stateSemanticDistance <= 0.18;
  const contextClose = (comparison.contextSimilarity ?? 0) >= 0.64;
  const visualClose = visual >= 0.72;
  const exactVisualAnchor = visual >= 0.9;
  const hasFailureSignal = isFailureStep(textStep) || isFailureStep(visionStep);
  const valueConflict = hasActionValueConflict(textStep, visionStep);
  const nextConfirms =
    Boolean(next?.textStep && next?.visionStep) &&
    next!.stateSemanticDistance <= 0.24 &&
    (next!.contextSimilarity ?? 0) >= 0.58 &&
    next!.relation !== "hard_divergence" &&
    !strongVisualMismatch(next!.textStep, next!.visionStep);
  const previousWasHard =
    previous?.event === "diverged" ||
    previous?.event === "persistent_divergence" ||
    previous?.relation === "hard_divergence" ||
    previous?.relation === "a_extra" ||
    previous?.relation === "b_extra";
  const genericPair = genericPairRequiresStrongerEvidence(textStep, visionStep);
  if (comparison.relation === "hard_divergence") return false;
  if (comparison.relation === "soft_mismatch" && comparison.targetElementDiff > 0.38) return false;
  if (valueConflict) return false;
  if (strongVisualMismatch(textStep, visionStep) && !visualClose) return false;
  if (!stateClose || !contextClose) return false;
  if (hasFailureSignal && !pairedFailureHasRejoinEvidence(comparison, next)) return false;
  const navigationResultOverlap =
    comparison.relation === "matched" &&
    new Set([textStep.actionType, visionStep.actionType]).has("navigate") &&
    (comparison.contextSimilarity ?? 0) >= 0.95 &&
    comparison.stateSemanticDistance <= 0.16 &&
    comparison.targetElementDiff <= 0.24;
  if (navigationResultOverlap) return true;
  if (genericPair) {
    return Boolean(visualClose && genericTargetClose && comparison.relation === "matched" && (nextConfirms || (comparison.contextSimilarity ?? 0) >= 0.9));
  }
  if (
    action >= 0.55 &&
    ((previousWasHard ? postDivergenceTargetClose : targetClose) ||
      (exactVisualAnchor && (previousWasHard ? postDivergenceTargetClose : targetAcceptableForConfirmedRejoin)) ||
      (nextConfirms && (previousWasHard ? postDivergenceTargetClose : targetAcceptableForConfirmedRejoin)))
  ) {
    return true;
  }
  if (exactVisualAnchor && (previousWasHard ? postDivergenceTargetClose : targetAcceptableForConfirmedRejoin)) return true;
  return Boolean(visualClose && (previousWasHard ? postDivergenceTargetClose : targetClose) && (!previousWasHard || nextConfirms));
}

function comparisonHasStrongRejoinEvidence(comparison: GuiTraceStepComparison, next?: GuiTraceStepComparison): boolean {
  if (!comparison.textStep || !comparison.visionStep) return false;
  if (strongVisualMismatch(comparison.textStep, comparison.visionStep)) return false;
  if (hasActionValueConflict(comparison.textStep, comparison.visionStep)) return false;
  if ((isFailureStep(comparison.textStep) || isFailureStep(comparison.visionStep)) && !pairedFailureHasRejoinEvidence(comparison, next)) return false;
  const visual = visualSimilarity(comparison.textStep, comparison.visionStep);
  const nextConfirms =
    Boolean(next?.textStep && next?.visionStep) &&
    next!.relation !== "hard_divergence" &&
    next!.stateSemanticDistance <= 0.16 &&
    (next!.contextSimilarity ?? 0) >= 0.72 &&
    !strongVisualMismatch(next!.textStep, next!.visionStep);
  return (
    comparison.relation === "matched" &&
    comparison.divergenceScore <= 0.18 &&
    comparison.stateSemanticDistance <= 0.1 &&
    comparison.targetElementDiff <= 0.18 &&
    (comparison.contextSimilarity ?? 0) >= 0.76 &&
    (visual >= 0.8 || nextConfirms)
  );
}

function rejoinNeedsStrongEvidence({
  knownOutcomeMismatch,
  oneSidedGapCountSinceDivergence,
}: {
  knownOutcomeMismatch: boolean;
  oneSidedGapCountSinceDivergence: number;
}): boolean {
  return knownOutcomeMismatch || oneSidedGapCountSinceDivergence >= 8;
}

function rejoinStateKey(step: GuiAgentTraceStep | null | undefined): string | undefined {
  if (!step) return undefined;
  const route = routeFromStep(step);
  const normalizedState = normalizeStateText(step.stateAfter);
  const effectiveTarget = normalizeStateText(effectiveTargetLabel(step));
  const visualSignature = step.visualStateSignature?.split(/[;|,\s]+/).find((part) => /^[a-f0-9]{16}$/i.test(part));
  if (visualSignature && effectiveTarget && !isGenericBrowserTarget(step)) return `visual:${visualSignature}:${effectiveTarget.slice(0, 64)}`;
  if (route && !/\[local\]|web page|local url removed|about blank/.test(route) && effectiveTarget) return `route:${route}:${effectiveTarget.slice(0, 64)}`;
  if (normalizedState.length > 32 && !/\b(web page|local url removed|local origin|about blank)\b/.test(normalizedState) && effectiveTarget) {
    return `state:${normalizedState.slice(0, 120)}:${effectiveTarget.slice(0, 64)}`;
  }
  return undefined;
}

function pairedFailureHasRejoinEvidence(comparison: GuiTraceStepComparison, next?: GuiTraceStepComparison): boolean {
  if (!comparison.textStep || !comparison.visionStep) return false;
  if (!isFailureStep(comparison.textStep) && !isFailureStep(comparison.visionStep)) return false;
  if (strongVisualMismatch(comparison.textStep, comparison.visionStep)) return false;
  const oneSidedFailure = isFailureStep(comparison.textStep) !== isFailureStep(comparison.visionStep);
  const visual = visualSimilarity(comparison.textStep, comparison.visionStep);
  const action = actionSimilarity(comparison.textStep, comparison.visionStep);
  const context = comparison.contextSimilarity ?? 0;
  const nextConfirms =
    Boolean(next?.textStep && next?.visionStep) &&
    next!.relation !== "hard_divergence" &&
    next!.stateSemanticDistance <= 0.2 &&
    (next!.contextSimilarity ?? 0) >= 0.58 &&
    !strongVisualMismatch(next!.textStep, next!.visionStep);
  if (oneSidedFailure) {
    return (
      comparison.relation === "matched" &&
      comparison.stateSemanticDistance <= 0.1 &&
      comparison.targetElementDiff <= 0.12 &&
      action >= 0.7 &&
      (context >= 0.78 || visual >= 0.82)
    );
  }
  return (
    comparison.relation !== "hard_divergence" &&
    comparison.stateSemanticDistance <= 0.2 &&
    comparison.targetElementDiff <= 0.28 &&
    action >= 0.55 &&
    (context >= 0.64 || visual >= 0.72 || nextConfirms)
  );
}

function comparisonHasTerminalFailure(comparison: GuiTraceStepComparison, next?: GuiTraceStepComparison): boolean {
  if (comparison.event === "rejoined") return false;
  const hasFailureSignal = isFailureStep(comparison.textStep) || isFailureStep(comparison.visionStep);
  if (!hasFailureSignal) return false;
  if (pairedFailureHasRejoinEvidence(comparison, next)) return false;
  if (!comparison.textStep || !comparison.visionStep) return true;
  return comparison.relation === "hard_divergence" || comparison.stateSemanticDistance >= 0.5 || comparison.targetElementDiff >= 0.5;
}

export function compareGuiTraceStep({
  stepIndex,
  textStep,
  visionStep,
  screenshotSize,
  priorDiverged,
  alignmentCost,
  contextSimilarity: alignedContextSimilarity,
  relation,
}: {
  stepIndex: number;
  textStep: GuiAgentTraceStep | null;
  visionStep: GuiAgentTraceStep | null;
  screenshotSize: GuiAgentTask["screenshotSize"];
  priorDiverged: boolean;
  alignmentCost?: number;
  contextSimilarity?: number;
  relation?: GuiAlignmentPair["relation"];
}): GuiTraceStepComparison {
  const presentStep = textStep ?? visionStep;
  const rawActionTypeDiff =
    textStep && visionStep
      ? textStep.actionType === visionStep.actionType
        ? 0
        : 1
      : missingCounterpartDistance(presentStep, "missing-action", 0.62, 0.28);
  const rawTargetElementDiff = targetElementDifference(textStep, visionStep);
  const rawScreenRegionDistance = screenDistance(textStep, visionStep, screenshotSize);
  const visualFrameSimilarity = visualSimilarity(textStep, visionStep);
  const visualFrameMismatch = strongVisualMismatch(textStep, visionStep);
  const overlapAnchor =
    textStep &&
    visionStep &&
    visualFrameSimilarity >= 0.95 &&
    actionSimilarity(textStep, visionStep) >= 0.8 &&
    (rawTargetElementDiff <= 0.55 || rawScreenRegionDistance <= 0.18);
  const contextualOverlapAnchor =
    textStep &&
    visionStep &&
    typeof alignmentCost === "number" &&
    typeof alignedContextSimilarity === "number" &&
    alignmentCost <= 0.34 &&
    alignedContextSimilarity >= 0.48 &&
    (!visualFrameMismatch || alignedContextSimilarity >= 0.76 || rawTargetElementDiff <= 0.18) &&
    Boolean(textStep.thumbnailRef || textStep.screenshotRef || visionStep.thumbnailRef || visionStep.screenshotRef);
  const actionTypeDiff = overlapAnchor || contextualOverlapAnchor ? Math.min(rawActionTypeDiff, 0.18) : rawActionTypeDiff;
  const targetElementDiff = overlapAnchor || contextualOverlapAnchor ? Math.min(rawTargetElementDiff, contextualOverlapAnchor ? 0.24 : 0.18) : rawTargetElementDiff;
  const screenRegionDistance =
    overlapAnchor || contextualOverlapAnchor ? Math.min(rawScreenRegionDistance, contextualOverlapAnchor ? 0.16 : 0.08) : rawScreenRegionDistance;
  const rationaleSemanticDistance =
    textStep && visionStep
      ? 1 - jaccardSimilarity(textStep.structuredRationale, visionStep.structuredRationale)
      : missingCounterpartDistance(presentStep, "missing-rationale", 0.5, 0.36);
  const confidenceGap =
    textStep && visionStep ? Math.abs(textStep.confidence - visionStep.confidence) : missingCounterpartDistance(presentStep, "missing-confidence", 0.12, 0.26);
  const rawStateTransitionDiff = textStep && visionStep && textStep.stateAfter === visionStep.stateAfter ? 0 : 1;
  const rawSemanticStateDistance = stateSemanticDistance(textStep, visionStep);
  const stateTransitionDiff = overlapAnchor || contextualOverlapAnchor ? 0 : rawStateTransitionDiff;
  const semanticStateDistance =
    overlapAnchor || contextualOverlapAnchor ? Math.min(rawSemanticStateDistance, contextualOverlapAnchor ? 0.16 : 0.1) : rawSemanticStateDistance;
  const weightedComponents = [
    0.16 * actionTypeDiff,
    0.26 * targetElementDiff,
    0.1 * screenRegionDistance,
    0.05 * rationaleSemanticDistance,
    0.12 * stateTransitionDiff,
    0.31 * semanticStateDistance,
  ];
  const baseDivergenceScore = 1 - weightedComponents.reduce((product, component) => product * (1 - clamp01(component)), 1);
  const criticalTransitionMismatch = semanticStateDistance >= 0.68 && (targetElementDiff >= 0.5 || actionTypeDiff >= 0.85);
  const hasFailureSignal = isFailureStep(textStep) || isFailureStep(visionStep);
  const oneSidedFailureSignal = Boolean(textStep && visionStep && isFailureStep(textStep) !== isFailureStep(visionStep));
  const strictOneSidedFailureMatch =
    oneSidedFailureSignal &&
    relation === "matched" &&
    semanticStateDistance <= 0.1 &&
    targetElementDiff <= 0.12 &&
    actionSimilarity(textStep, visionStep) >= 0.7 &&
    ((alignedContextSimilarity ?? 0) >= 0.78 || visualFrameSimilarity >= 0.82);
  const pairedFailureCanStillMatch =
    hasFailureSignal &&
    textStep &&
    visionStep &&
    (oneSidedFailureSignal
      ? strictOneSidedFailureMatch
      : overlapAnchor ||
        contextualOverlapAnchor ||
        (relation !== "hard_divergence" &&
          semanticStateDistance <= 0.2 &&
          targetElementDiff <= 0.28 &&
          actionSimilarity(textStep, visionStep) >= 0.55 &&
          ((alignedContextSimilarity ?? 0) >= 0.64 || visualFrameSimilarity >= 0.72)));
  const terminalFailure = hasFailureSignal && !pairedFailureCanStillMatch && (!textStep || !visionStep || relation === "hard_divergence" || semanticStateDistance >= 0.5);
  const criticalFloor = criticalTransitionMismatch
    ? clamp01(
        0.56 +
          0.07 * semanticStateDistance +
          0.05 * targetElementDiff +
          0.03 * actionTypeDiff +
          0.04 * missingCounterpartDistance(presentStep, "critical-floor", 0, 1),
      )
      : 0;
  const divergenceScore = clamp01(Math.max(baseDivergenceScore + 0.04 * confidenceGap, criticalFloor, terminalFailure ? 0.62 : 0));
  const divergenceAngle = Math.round(4 + divergenceScore * 38);
  const stepConvergenceScore = convergenceScore(textStep, visionStep, priorDiverged);
  const stateCloseEnoughToRejoin = stateTransitionDiff === 0 || semanticStateDistance <= 0.18;
  const hardAlignmentDivergence = relation === "hard_divergence" || relation === "a_extra" || relation === "b_extra";
  const valueConflict = hasActionValueConflict(textStep, visionStep);
  const oneSidedUnmatchedFailure =
    hasFailureSignal &&
    textStep &&
    visionStep &&
    oneSidedFailureSignal &&
    !pairedFailureCanStillMatch;
  const event: GuiTraceStepComparison["event"] =
    terminalFailure
      ? "diverged"
    : oneSidedUnmatchedFailure
      ? priorDiverged
        ? "persistent_divergence"
        : "diverged"
    : valueConflict
      ? priorDiverged
        ? "persistent_divergence"
        : "diverged"
    : contextualOverlapAnchor
      ? priorDiverged
        ? "converging"
        : "stable"
    : hardAlignmentDivergence
      ? priorDiverged
        ? "persistent_divergence"
        : "diverged"
    : priorDiverged && stepConvergenceScore >= 0.7 && stateCloseEnoughToRejoin
      ? "converging"
      : divergenceScore >= 0.38 || criticalTransitionMismatch
        ? "diverged"
        : priorDiverged && stepConvergenceScore >= 0.45
          ? "converging"
          : priorDiverged
            ? "persistent_divergence"
            : "stable";
  const label =
    terminalFailure
      ? "Agent failure / stop"
      : event === "diverged"
        ? targetElementDiff > 0 ? "Different target" : "Different action"
        : event === "converging"
          ? "Converging"
          : event === "persistent_divergence"
            ? "Persistent divergence"
            : "Stable";

  return {
    stepIndex,
    textStep,
    visionStep,
    actionTypeDiff,
    targetElementDiff,
    screenRegionDistance: roundOne(screenRegionDistance),
    rationaleSemanticDistance: roundOne(rationaleSemanticDistance),
    confidenceGap: roundOne(confidenceGap),
    stateTransitionDiff,
    stateSemanticDistance: roundThree(semanticStateDistance),
    divergenceScore: roundThree(divergenceScore),
    divergenceAngle,
    convergenceScore: stepConvergenceScore,
    event,
    label,
    alignmentCost: typeof alignmentCost === "number" ? roundThree(alignmentCost) : undefined,
    contextSimilarity: typeof alignedContextSimilarity === "number" ? roundThree(alignedContextSimilarity) : undefined,
    relation,
  };
}

function actionAtomForComparisonStep(step: GuiAgentTraceStep | null, screenshotSize: GuiAgentTask["screenshotSize"]): GuiActionAtom | undefined {
  return actionAtomForStep(step, screenshotSize);
}

function hasModality(step: GuiAgentTraceStep | null, modality: "dom" | "a11y" | "ocr" | "vision"): boolean {
  if (!step) return false;
  return uiEntitiesForStep(step, { width: 1280, height: 820 }).some((entity) => entity.modalitySources.includes(modality));
}

function isIrreversibleAction(action: GuiActionAtom | undefined): boolean {
  if (!action) return false;
  const target = normalizedTargetLabel([action.op, action.targetText, action.intentLabel].filter(Boolean).join(" "));
  return (
    action.op === "submit" ||
    /\b(delete|remove|submit|confirm|send|pay|purchase|place order|save changes|save)\b/i.test(target)
  );
}

function classifyDivergence(comparison: GuiTraceStepComparison, task: GuiAgentTask): NonNullable<GuiTraceStepComparison["divergenceType"]> | undefined {
  if (comparison.event === "rejoined") return undefined;
  const actionA = actionAtomForComparisonStep(comparison.textStep, task.screenshotSize);
  const actionB = actionAtomForComparisonStep(comparison.visionStep, task.screenshotSize);
  if (comparisonHasTerminalFailure(comparison)) return "agent_failure";
  if (!comparison.textStep || !comparison.visionStep) return "extra_recovery_step";
  if (isIrreversibleAction(actionA) || isIrreversibleAction(actionB)) return "irreversible_side_effect";
  if ((hasModality(comparison.textStep, "dom") || hasModality(comparison.textStep, "a11y")) && !hasModality(comparison.textStep, "vision")) {
    return "missing_visual_entity";
  }
  if (hasModality(comparison.visionStep, "vision") && !hasModality(comparison.visionStep, "dom") && !hasModality(comparison.visionStep, "a11y")) {
    return "missing_dom_entity";
  }
  if (actionA?.op !== actionB?.op && comparison.stateSemanticDistance < 0.3) return "operation_mismatch";
  if (actionA?.op === actionB?.op && comparison.targetElementDiff >= 0.5 && bboxIou(actionA?.targetBbox, actionB?.targetBbox) < 0.3) {
    return "target_mismatch";
  }
  if (actionAtomSimilarity(actionA, actionB) >= 0.7 && comparison.stateSemanticDistance >= 0.4) return "state_transition_mismatch";
  if (comparison.relation === "hard_divergence") return "state_transition_mismatch";
  return comparison.divergenceScore >= 0.38 ? "target_mismatch" : undefined;
}

function divergenceSeverity(comparison: GuiTraceStepComparison, type: NonNullable<GuiTraceStepComparison["divergenceType"]>, noRejoin = false): "low" | "medium" | "high" {
  if (type === "agent_failure") return "high";
  if (type === "irreversible_side_effect" && noRejoin) return "high";
  if (comparison.divergenceScore >= 0.68 || comparison.relation === "hard_divergence") return "high";
  if (comparison.divergenceScore >= 0.38 || type === "state_transition_mismatch") return "medium";
  return "low";
}

function buildDivergenceRecord(comparison: GuiTraceStepComparison, task: GuiAgentTask, ordinal: number, noRejoin = false): GuiDivergenceRecord | null {
  const divergenceType = comparison.divergenceType ?? classifyDivergence(comparison, task);
  if (!divergenceType) return null;
  const actionA = actionAtomForComparisonStep(comparison.textStep, task.screenshotSize);
  const actionB = actionAtomForComparisonStep(comparison.visionStep, task.screenshotSize);
  return {
    divergenceId: `${task.taskId}-div-${ordinal}`,
    stepAIndex: comparison.textStep?.stepIndex,
    stepBIndex: comparison.visionStep?.stepIndex,
    divergenceType,
    severity: divergenceSeverity(comparison, divergenceType, noRejoin),
    evidence: {
      actionA,
      actionB,
      stateAfterSimilarity: roundThree(1 - comparison.stateSemanticDistance),
      targetSimilarity: roundThree(1 - comparison.targetElementDiff),
      visualSimilarity: roundThree(visualSimilarity(comparison.textStep, comparison.visionStep)),
    },
    explanationShort:
      divergenceType === "agent_failure"
        ? "One run reports an observable failure, stop, or repeated-action termination."
        : divergenceType === "extra_recovery_step"
        ? "One run contains an extra observable recovery or transition step."
        : divergenceType.replace(/_/g, " "),
  };
}

function buildRejoinRecords(divergences: GuiDivergenceRecord[], comparisons: GuiTraceStepComparison[], task: GuiAgentTask): GuiRejoinRecord[] {
  return divergences.map((divergence) => {
    const start = comparisons.findIndex(
      (comparison) => comparison.textStep?.stepIndex === divergence.stepAIndex || comparison.visionStep?.stepIndex === divergence.stepBIndex,
    );
    const rejoin = comparisons.slice(Math.max(0, start + 1)).find((comparison, offset, tail) => {
      if (comparison.event === "rejoined") return true;
      const currentSimilar = comparison.textStep && comparison.visionStep && comparison.stateSemanticDistance <= 0.15;
      const next = tail[offset + 1];
      const nextSimilar = next?.textStep && next?.visionStep && next.stateSemanticDistance <= 0.25;
      return Boolean(currentSimilar && nextSimilar);
    });
    const recoveryActionsA = comparisons
      .slice(Math.max(0, start + 1), rejoin ? comparisons.indexOf(rejoin) + 1 : comparisons.length)
      .map((comparison) => actionAtomForComparisonStep(comparison.textStep, task.screenshotSize))
      .filter((action): action is GuiActionAtom => Boolean(action));
    const recoveryActionsB = comparisons
      .slice(Math.max(0, start + 1), rejoin ? comparisons.indexOf(rejoin) + 1 : comparisons.length)
      .map((comparison) => actionAtomForComparisonStep(comparison.visionStep, task.screenshotSize))
      .filter((action): action is GuiActionAtom => Boolean(action));
    return {
      divergenceId: divergence.divergenceId,
      rejoined: Boolean(rejoin),
      rejoinStepA: rejoin?.textStep?.stepIndex,
      rejoinStepB: rejoin?.visionStep?.stepIndex,
      recoveryLengthA: recoveryActionsA.length,
      recoveryLengthB: recoveryActionsB.length,
      recoveryActionsA,
      recoveryActionsB,
    };
  });
}

function buildTraceGraph(task: GuiAgentTask, traces: GuiAgentTrace[]): GuiTraceGraph {
  const nodeMap = new Map<string, GuiTraceGraph["nodes"][number]>();
  const edgeMap = new Map<string, GuiTraceGraph["edges"][number]>();
  const runOutcome = new Map(traces.map((trace) => [trace.traceId, inferredTraceOutcome(trace)]));
  for (const trace of traces) {
    const seenStates = new Set<string>();
    const ordered = [...trace.steps].sort((a, b) => a.stepIndex - b.stepIndex);
    for (const [index, step] of ordered.entries()) {
      const state = canonicalStateForStep(step, task);
      const nodeId = state.signature;
      const outcome = runOutcome.get(trace.traceId);
      const existing = nodeMap.get(nodeId);
      const agentType = trace.observationMode ?? trace.agentKind;
      if (existing) {
        existing.successCount += outcome === "success" ? 1 : 0;
        existing.failureCount += outcome === "failed" ? 1 : 0;
        existing.loopCount += seenStates.has(nodeId) ? 1 : 0;
        existing.agentTypesSeen = [...new Set([...existing.agentTypesSeen, agentType])];
      } else {
        nodeMap.set(nodeId, {
          nodeId,
          stateSignature: state.signature,
          label: step.target.label,
          successCount: outcome === "success" ? 1 : 0,
          failureCount: outcome === "failed" ? 1 : 0,
          agentTypesSeen: [agentType],
          modalityConflicts: 0,
          loopCount: seenStates.has(nodeId) ? 1 : 0,
        });
      }
      seenStates.add(nodeId);
      const next = ordered[index + 1];
      if (!next) continue;
      const nextState = canonicalStateForStep(next, task);
      const action: GuiActionAtom = actionAtomForStep(step, task.screenshotSize) ?? { op: "unknown" };
      const edgeId = `${nodeId}->${nextState.signature}:${action.op}:${action.targetEntityId ?? action.targetText ?? ""}`;
      const edge = edgeMap.get(edgeId);
      const isFailure = outcome === "failed";
      const isSuccess = outcome === "success";
      if (edge) {
        edge.runIds = [...new Set([...edge.runIds, trace.traceId])];
        edge.failureRate = roundThree((edge.failureRate * (edge.runIds.length - 1) + (isFailure ? 1 : 0)) / edge.runIds.length);
        edge.successRate = roundThree((edge.successRate * (edge.runIds.length - 1) + (isSuccess ? 1 : 0)) / edge.runIds.length);
        edge.usedByVision ||= trace.observationMode === "vision";
        edge.usedByDom ||= trace.observationMode === "text" || trace.agentKind === "text_dom";
      } else {
        edgeMap.set(edgeId, {
          edgeId,
          fromNodeId: nodeId,
          toNodeId: nextState.signature,
          action,
          runIds: [trace.traceId],
          successRate: isSuccess ? 1 : 0,
          failureRate: isFailure ? 1 : 0,
          avgRecoveryLength: 0,
          irreversibleCount: isIrreversibleAction(action) ? 1 : 0,
          usedByVision: trace.observationMode === "vision",
          usedByDom: trace.observationMode === "text" || trace.agentKind === "text_dom",
        });
      }
    }
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

function buildTraceMetrics({
  comparisons,
  alignments,
  divergences,
  rejoins,
  graph,
  maxTraceLength,
}: {
  comparisons: GuiTraceStepComparison[];
  alignments: GuiAlignmentPair[];
  divergences: GuiDivergenceRecord[];
  rejoins: GuiRejoinRecord[];
  graph: GuiTraceGraph;
  maxTraceLength: number;
}): GuiTraceMetrics {
  const totalCost = alignments.reduce((sum, alignment) => sum + alignment.alignmentCost, 0);
  const loopCount = graph.nodes.reduce((sum, node) => sum + node.loopCount, 0);
  const failedStepsInTrap = graph.nodes.filter((node) => node.failureCount > node.successCount && node.failureCount > 0).reduce((sum, node) => sum + node.failureCount, 0);
  const failedSteps = graph.nodes.reduce((sum, node) => sum + node.failureCount, 0);
  return {
    firstDivergenceStep: comparisons.find((comparison) => comparison.event === "diverged" || comparison.relation === "hard_divergence")?.stepIndex ?? null,
    divergenceCount: divergences.length,
    hardDivergenceCount: alignments.filter((alignment) => alignment.relation === "hard_divergence").length,
    softMismatchCount: alignments.filter((alignment) => alignment.relation === "soft_mismatch").length,
    normalizedTrajectoryEditDistance: roundThree(safeDivide(totalCost, Math.max(1, maxTraceLength))),
    rejoinRate: roundThree(safeDivide(rejoins.filter((rejoin) => rejoin.rejoined).length, Math.max(1, divergences.length))),
    avgRecoveryLength: roundThree(safeDivide(rejoins.reduce((sum, rejoin) => sum + Math.max(rejoin.recoveryLengthA ?? 0, rejoin.recoveryLengthB ?? 0), 0), Math.max(1, rejoins.length))),
    targetMismatchCount: divergences.filter((divergence) => divergence.divergenceType === "target_mismatch").length,
    modalityEvidenceConflictCount: divergences.filter((divergence) => divergence.divergenceType === "modality_evidence_conflict").length,
    missingVisualEntityCount: divergences.filter((divergence) => divergence.divergenceType === "missing_visual_entity").length,
    missingDomEntityCount: divergences.filter((divergence) => divergence.divergenceType === "missing_dom_entity").length,
    loopCount,
    backtrackCount: loopCount,
    irreversibleSideEffectCount: divergences.filter((divergence) => divergence.divergenceType === "irreversible_side_effect").length,
    productiveCoreOverlap: roundThree(safeDivide(graph.nodes.filter((node) => node.successCount > 0 && node.failureCount === 0).length, Math.max(1, graph.nodes.filter((node) => node.successCount > 0).length))),
    trapRegionExposure: roundThree(safeDivide(failedStepsInTrap, Math.max(1, failedSteps))),
  };
}

export function analyzeGuiAgentTraces(task: GuiAgentTask, textTrace: GuiAgentTrace, visionTrace: GuiAgentTrace): GuiTraceAnalysis {
  let priorDiverged = false;
  let hasDiverged = false;
  let rejoinStep: number | null = null;
  let oneSidedGapCountSinceDivergence = 0;
  const knownOutcomeMismatch =
    Boolean(textTrace.outcome && visionTrace.outcome && textTrace.outcome !== "unknown" && visionTrace.outcome !== "unknown") &&
    textTrace.outcome !== visionTrace.outcome;
  const textStatesAfterDivergence = new Map<string, number>();
  const visionStatesAfterDivergence = new Map<string, number>();
  const comparisons: GuiTraceStepComparison[] = [];
  const alignedRows = alignTraceSteps(textTrace, visionTrace, task);
  const alignments: GuiAlignmentPair[] = alignedRows.map((row) => ({
    stepA: row.textStep ?? undefined,
    stepB: row.visionStep ?? undefined,
    alignmentCost: row.alignmentCost,
    relation: row.relation,
  }));

  for (let index = 1; index <= alignedRows.length; index += 1) {
    const alignedRow = alignedRows[index - 1];
    const comparison = compareGuiTraceStep({
      stepIndex: index,
      textStep: alignedRow.textStep,
      visionStep: alignedRow.visionStep,
      screenshotSize: task.screenshotSize,
      priorDiverged,
      alignmentCost: alignedRow.alignmentCost,
      contextSimilarity: alignedRow.contextSimilarity,
      relation: alignedRow.relation,
    });
    const recoverableGap =
      (alignedRow.relation === "a_extra" || alignedRow.relation === "b_extra") &&
      alignedRows
        .slice(index)
        .some((candidate) => candidate.textStep && candidate.visionStep && (candidate.relation === "matched" || candidate.relation === "soft_mismatch"));
    const oneSidedRow = alignedRow.relation === "a_extra" || alignedRow.relation === "b_extra";
    if (recoverableGap) {
      comparison.divergenceScore = Math.min(comparison.divergenceScore, 0.34);
      comparison.divergenceAngle = Math.min(comparison.divergenceAngle, 16);
      comparison.event = priorDiverged ? "persistent_divergence" : "diverged";
      comparison.label = "Extra recovery step";
    }
    if (priorDiverged && oneSidedRow && !isFailureStep(comparison.textStep) && !isFailureStep(comparison.visionStep)) {
      comparison.event = "persistent_divergence";
      comparison.label = recoverableGap ? "Extra recovery step" : "Persistent extra step";
    }
    comparison.divergenceType = classifyDivergence(comparison, task);
    comparisons.push(comparison);

    if (comparison.event === "diverged") {
      priorDiverged = true;
      hasDiverged = true;
    }
    if (priorDiverged && oneSidedRow) {
      oneSidedGapCountSinceDivergence += 1;
    }

    if (priorDiverged) {
      const previousComparison = comparisons[comparisons.length - 2];
      const nextRow = alignedRows[index];
      const nextComparison = nextRow
        ? compareGuiTraceStep({
            stepIndex: index + 1,
            textStep: nextRow.textStep,
            visionStep: nextRow.visionStep,
            screenshotSize: task.screenshotSize,
            priorDiverged: true,
            alignmentCost: nextRow.alignmentCost,
            contextSimilarity: nextRow.contextSimilarity,
            relation: nextRow.relation,
          })
        : undefined;
      const textStateKey = rejoinStateKey(comparison.textStep);
      const visionStateKey = rejoinStateKey(comparison.visionStep);
      if (textStateKey) {
        textStatesAfterDivergence.set(textStateKey, index);
      }
      if (visionStateKey) {
        visionStatesAfterDivergence.set(visionStateKey, index);
      }
      const sharedState = [...textStatesAfterDivergence.keys()].find((state) => visionStatesAfterDivergence.has(state));
      const currentHasRejoinEvidence = comparisonHasRejoinEvidence(comparison, previousComparison, nextComparison);
      const currentHasStrongRejoinEvidence = comparisonHasStrongRejoinEvidence(comparison, nextComparison);
      const rejoinNeedsStrongerEvidence = rejoinNeedsStrongEvidence({ knownOutcomeMismatch, oneSidedGapCountSinceDivergence });
      const canAcceptRejoin = currentHasRejoinEvidence && (!rejoinNeedsStrongerEvidence || currentHasStrongRejoinEvidence);
      if (sharedState && canAcceptRejoin) {
        const textStateStep = textStatesAfterDivergence.get(sharedState) ?? index;
        const visionStateStep = visionStatesAfterDivergence.get(sharedState) ?? index;
        const joinedAt = Math.max(textStateStep, visionStateStep);
        const joinedIndex = comparisons.findIndex((candidate) => candidate.stepIndex === joinedAt);
        const joinedCandidate = joinedIndex >= 0 ? comparisons[joinedIndex] : undefined;
        const joinedCandidateHasEvidence =
          joinedCandidate &&
          comparisonHasRejoinEvidence(joinedCandidate, comparisons[joinedIndex - 1], comparisons[joinedIndex + 1]) &&
          (!rejoinNeedsStrongerEvidence || comparisonHasStrongRejoinEvidence(joinedCandidate, comparisons[joinedIndex + 1]));
        const joinedComparison = joinedCandidateHasEvidence ? joinedCandidate : comparison;
        joinedComparison.event = "rejoined";
        joinedComparison.label = "Rejoined";
        joinedComparison.divergenceType = undefined;
        joinedComparison.convergenceScore = Math.max(joinedComparison.convergenceScore, 0.7);
        joinedComparison.divergenceAngle = Math.min(joinedComparison.divergenceAngle, 14);
        if (rejoinStep === null) rejoinStep = joinedComparison.stepIndex;
        priorDiverged = false;
        oneSidedGapCountSinceDivergence = 0;
      } else if (currentHasRejoinEvidence) {
        if (canAcceptRejoin) {
          comparison.event = "rejoined";
          comparison.label = "Rejoined";
          comparison.divergenceType = undefined;
          comparison.convergenceScore = Math.max(comparison.convergenceScore, 0.7);
          comparison.divergenceAngle = Math.min(comparison.divergenceAngle, 14);
          if (rejoinStep === null) rejoinStep = index;
          priorDiverged = false;
          oneSidedGapCountSinceDivergence = 0;
        } else if (comparison.event === "converging") {
          comparison.event = "persistent_divergence";
          comparison.label = "Persistent divergence";
        }
      }
    }

    if (
      comparison.event === "rejoined" &&
      rejoinStep === null &&
      comparisonHasRejoinEvidence(comparison, comparisons[comparisons.length - 2]) &&
      (!rejoinNeedsStrongEvidence({ knownOutcomeMismatch, oneSidedGapCountSinceDivergence }) || comparisonHasStrongRejoinEvidence(comparison))
    ) {
      rejoinStep = index;
      priorDiverged = false;
      oneSidedGapCountSinceDivergence = 0;
    }
  }

  const maxDivergenceScore = comparisons.length ? Math.max(...comparisons.map((comparison) => comparison.divergenceScore)) : 0;
  const meanDivergenceScore = comparisons.length
    ? roundThree(comparisons.reduce((sum, comparison) => sum + comparison.divergenceScore, 0) / comparisons.length)
    : 0;
  const persistentDivergence = hasDiverged && priorDiverged;
  const divergenceComparisons = comparisons.filter(
    (comparison) => comparison.event === "diverged" || comparison.relation === "hard_divergence" || comparison.relation === "a_extra" || comparison.relation === "b_extra",
  );
  const divergences = divergenceComparisons
    .map((comparison, index) => buildDivergenceRecord(comparison, task, index + 1, persistentDivergence))
    .filter((record): record is GuiDivergenceRecord => Boolean(record));
  const rejoins = buildRejoinRecords(divergences, comparisons, task);
  const graph = buildTraceGraph(task, [textTrace, visionTrace]);
  const metrics = buildTraceMetrics({
    comparisons,
    alignments,
    divergences,
    rejoins,
    graph,
    maxTraceLength: Math.max(textTrace.steps.length, visionTrace.steps.length),
  });

  return {
    taskId: task.taskId,
    textTraceId: textTrace.traceId,
    visionTraceId: visionTrace.traceId,
    comparisons,
    maxDivergenceScore,
    meanDivergenceScore,
    rejoinStep,
    persistentDivergence,
    summary:
      rejoinStep !== null
        ? `Diverged and rejoined at step ${rejoinStep}.`
        : persistentDivergence
          ? "Persistent divergence through the final observable step."
          : "No high-divergence step detected.",
    alignments,
    divergences,
    rejoins,
    graph,
    metrics,
  };
}

function roundThree(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

