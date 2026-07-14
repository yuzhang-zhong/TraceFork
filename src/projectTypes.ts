export type ModelId = string;

export type GuiAgentKind = "text_dom" | "vision_gui" | "offline_run" | "human";
export type GuiAgentActionType = "click" | "type" | "scroll" | "select" | "wait" | "navigate";
export type GuiTraceSourceType = "normalized_json" | "webarena_execution_bundle" | "playwright_human_trace";
export type GuiTraceAdapterConfidence = "high" | "medium" | "low";
export type GuiTraceBenchmark = "webarena" | "visualwebarena" | "custom";

export type GuiAgentTarget = {
  label: string;
  domSelector?: string;
  bbox: [number, number, number, number];
};

export type GuiEvidenceModality = "dom" | "a11y" | "ocr" | "vision";

export type GuiUIEntity = {
  entityId: string;
  text?: string;
  role?: string;
  bbox?: [number, number, number, number];
  domRef?: string;
  a11yRef?: string;
  ocrRef?: string;
  visualRef?: string;
  isClickable?: boolean;
  modalitySources: GuiEvidenceModality[];
};

export type GuiActionAtom = {
  op: GuiAgentActionType | "submit" | "unknown";
  targetEntityId?: string;
  targetText?: string;
  targetBbox?: [number, number, number, number];
  value?: string;
  intentLabel?: string;
  confidence?: number;
};

export type GuiCanonicalState = {
  signature: string;
  urlRoute?: string;
  appName?: string;
  windowTitle?: string;
  entityKeys: string[];
  ocrTextSet: string[];
  layoutKeys: string[];
  visualFingerprint?: string;
  visualStateSignature?: string;
};

export type GuiTraceEdge = {
  fromState: string;
  toState: string;
  action: GuiActionAtom;
  runId: string;
  stepIndex: number;
};

export type GuiAgentTraceStep = {
  stepIndex: number;
  observationType: "dom" | "screenshot" | "mixed";
  observationSummary: string;
  actionType: GuiAgentActionType;
  target: GuiAgentTarget;
  inputText?: string;
  structuredRationale: string;
  agentOutputExcerpt?: string;
  confidence: number;
  stateAfter: string;
  url?: string;
  screenshotRef?: string;
  thumbnailRef?: string;
  visualFingerprint?: string;
  visualStateSignature?: string;
  sourceRef?: string;
  sourceHtmlPath?: string;
  visualFrameAvailable?: boolean;
  adapterConfidence?: GuiTraceAdapterConfidence;
  sourceWarnings?: string[];
  uiEntities?: GuiUIEntity[];
  normalizedAction?: GuiActionAtom;
  stateSignature?: string;
};

export type GuiAgentTrace = {
  traceId: string;
  agentId: string;
  agentKind: GuiAgentKind;
  modelId: ModelId;
  taskId: string;
  steps: GuiAgentTraceStep[];
  sourceType?: GuiTraceSourceType;
  sourceLabel?: string;
  sourceWarnings?: string[];
  benchmark?: GuiTraceBenchmark;
  site?: string;
  sourceCollection?: string;
  actorType?: "human" | "model" | "unknown";
  promptSetting?: string;
  observationMode?: "text" | "vision" | "mixed" | "unknown";
  outcome?: "success" | "failed" | "unknown";
  sourcePath?: string;
};

export type GuiAgentTask = {
  taskId: string;
  title: string;
  instruction: string;
  domain: string;
  startUrl: string;
  successCriteria: string;
  riskTags: string[];
  textState: string;
  visualState: string;
  screenshotSize: { width: number; height: number };
  traces: GuiAgentTrace[];
  sourceType?: GuiTraceSourceType;
  sourceLabel?: string;
  benchmark?: GuiTraceBenchmark;
  taskNumericId?: string;
  site?: string;
  sourceCollection?: string;
  sourcePath?: string;
  sourceFiles?: string[];
  adapterWarnings?: string[];
  adapterAudit?: GuiTraceAdapterAudit;
};

export type GuiTraceAdapterAudit = {
  sourceType: GuiTraceSourceType;
  parsedTaskCount: number;
  parsedRunCount: number;
  parsedStepCount: number;
  missingBboxCount: number;
  missingTargetLabelCount: number;
  lowConfidenceStepCount: number;
  detectedRenderHtmlCount: number;
  detectedMergeLogCount: number;
  detectedTraceFileCount: number;
  warnings: string[];
};

export type GuiTraceImportResult =
  | {
      ok: true;
      tasks: GuiAgentTask[];
      sourceType: GuiTraceSourceType;
      audit: GuiTraceAdapterAudit;
      warnings: string[];
    }
  | {
      ok: false;
      sourceType?: GuiTraceSourceType;
      errors: string[];
      warnings: string[];
    };

export type GuiTraceStepComparison = {
  stepIndex: number;
  textStep: GuiAgentTraceStep | null;
  visionStep: GuiAgentTraceStep | null;
  actionTypeDiff: number;
  targetElementDiff: number;
  screenRegionDistance: number;
  rationaleSemanticDistance: number;
  confidenceGap: number;
  stateTransitionDiff: number;
  stateSemanticDistance: number;
  divergenceScore: number;
  divergenceAngle: number;
  convergenceScore: number;
  event: "stable" | "diverged" | "converging" | "rejoined" | "persistent_divergence";
  label: string;
  alignmentCost?: number;
  contextSimilarity?: number;
  relation?: "matched" | "soft_mismatch" | "hard_divergence" | "a_extra" | "b_extra";
  divergenceType?:
    | "target_mismatch"
    | "operation_mismatch"
    | "state_transition_mismatch"
    | "modality_evidence_conflict"
    | "missing_visual_entity"
    | "missing_dom_entity"
    | "ocr_conflict"
    | "agent_failure"
    | "loop_or_backtrack"
    | "irreversible_side_effect"
    | "extra_recovery_step";
};

export type GuiAlignmentPair = {
  stepA?: GuiAgentTraceStep;
  stepB?: GuiAgentTraceStep;
  alignmentCost: number;
  relation: "matched" | "soft_mismatch" | "hard_divergence" | "a_extra" | "b_extra";
};

export type GuiDivergenceRecord = {
  divergenceId: string;
  stepAIndex?: number;
  stepBIndex?: number;
  divergenceType: NonNullable<GuiTraceStepComparison["divergenceType"]>;
  severity: "low" | "medium" | "high";
  evidence: {
    actionA?: GuiActionAtom;
    actionB?: GuiActionAtom;
    stateBeforeSimilarity?: number;
    stateAfterSimilarity?: number;
    targetSimilarity?: number;
    visualSimilarity?: number;
  };
  explanationShort: string;
};

export type GuiRejoinRecord = {
  divergenceId: string;
  rejoined: boolean;
  rejoinStepA?: number;
  rejoinStepB?: number;
  recoveryLengthA?: number;
  recoveryLengthB?: number;
  recoveryActionsA?: GuiActionAtom[];
  recoveryActionsB?: GuiActionAtom[];
};

export type GuiTraceGraphNode = {
  nodeId: string;
  stateSignature: string;
  label: string;
  successCount: number;
  failureCount: number;
  agentTypesSeen: string[];
  modalityConflicts: number;
  loopCount: number;
};

export type GuiTraceGraphEdge = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  action: GuiActionAtom;
  runIds: string[];
  successRate: number;
  failureRate: number;
  avgRecoveryLength: number;
  irreversibleCount: number;
  usedByVision: boolean;
  usedByDom: boolean;
};

export type GuiTraceGraph = {
  nodes: GuiTraceGraphNode[];
  edges: GuiTraceGraphEdge[];
};

export type GuiTraceMetrics = {
  firstDivergenceStep: number | null;
  divergenceCount: number;
  hardDivergenceCount: number;
  softMismatchCount: number;
  normalizedTrajectoryEditDistance: number;
  rejoinRate: number;
  avgRecoveryLength: number;
  targetMismatchCount: number;
  modalityEvidenceConflictCount: number;
  missingVisualEntityCount: number;
  missingDomEntityCount: number;
  loopCount: number;
  backtrackCount: number;
  irreversibleSideEffectCount: number;
  productiveCoreOverlap: number;
  trapRegionExposure: number;
};

export type GuiTraceAnalysis = {
  taskId: string;
  textTraceId: string;
  visionTraceId: string;
  comparisons: GuiTraceStepComparison[];
  maxDivergenceScore: number;
  meanDivergenceScore: number;
  rejoinStep: number | null;
  persistentDivergence: boolean;
  summary: string;
  alignments?: GuiAlignmentPair[];
  divergences?: GuiDivergenceRecord[];
  rejoins?: GuiRejoinRecord[];
  graph?: GuiTraceGraph;
  metrics?: GuiTraceMetrics;
};
