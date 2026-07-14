import { useEffect, useMemo, useState } from "react";
import "../shared/experimentStyles.css";
import {
  buildGoldItems,
  clearLegacyRecords,
  displayableFrame,
  downloadText,
  getStepContext,
  loadExperimentPairs,
  loadRecords,
  recordsToCsv,
  saveRecords,
  shortText,
  traceLabel,
  type GoldAnnotationRecord,
  type GoldItem,
} from "../shared/experimentData.js";
import type { GuiAgentTrace, GuiAgentTraceStep } from "../../projectTypes.js";

const legacyStorageKeys = ["tracefork-human-gold-subset-responses-v1"];
const storageKey = "tracefork-human-gold-subset-annotation-tool-v2";

const emptyForm = {
  label: "unsure" as GoldAnnotationRecord["label"],
  severity: 0 as GoldAnnotationRecord["severity"],
  laterOutcome: "unsure" as GoldAnnotationRecord["laterOutcome"],
  notes: "",
};

type ExperimentLanguage = "en" | "zh";

const copy = {
  en: {
    experiment: "Annotation tool",
    title: "Human gold annotation tool",
    subtitle: "Create your own overlap, fork severity, missing-counterpart, and rejoin labels. Records are stored only in this browser until exported.",
    language: "中文",
    annotatorId: "Annotator ID",
    annotatorPlaceholder: "e.g. ann-01",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    task: "Task",
    taskGuidance:
      "Judge the selected aligned step using the full trajectory context. System scores and labels are hidden from annotators.",
    alignedSteps: "Aligned trajectory steps",
    selectAnyStep: "select any step",
    saved: "saved",
    open: "open",
    stepJudgment: "Step judgment",
    unsaved: "unsaved",
    formGuidance:
      "First decide whether Run A and Run B overlap in GUI state and action intent. Use divergence, missing, or rejoin only when previous/current/next context and released output support it.",
    runAPrevCurrentNext: "Run A previous / current / next",
    runBPrevCurrentNext: "Run B previous / current / next",
    frameUnavailable: "frame unavailable",
    missingCounterpart: "missing counterpart",
    observableStep: "observable step",
    missingOrEnd: "missing / end",
    scoringEvidence: "Scoring evidence",
    currentNext: "current + next",
    evidenceBoundary:
      "Use only released observable output/rationale excerpts shown here; do not infer private chain-of-thought.",
    noReleasedOutput: "No released output excerpt.",
    labels: {
      overlap: "overlap",
      diverged: "diverged",
      missing_a: "A missing",
      missing_b: "B missing",
      rejoined: "rejoined",
      unsure: "unsure",
    },
    severity: "Severity",
    severityOptions: ["0: same / no issue", "1: minor difference", "2: meaningful divergence", "3: severe divergence"],
    laterOutcome: "Later outcome",
    outcomeOptions: { rejoined: "rejoined", persistent: "persistent", unsure: "unsure" },
    notes: "Notes",
    previous: "Previous",
    saveNext: "Save and next",
    savedHistory: "Saved history",
    localRecords: "local record(s)",
    savedProgress: "saved",
    noHistory: "No local annotations yet. Click Save and next to create your own exportable records.",
    loading: "Loading annotation items...",
    loadedSuffix: "aligned steps loaded from real/fallback pairs.",
  },
  zh: {
    experiment: "标注工具",
    title: "人工 Gold 标注工具",
    subtitle: "创建你自己的重叠、分叉强度、缺失对应步和回归标注。记录只保存在当前浏览器，直到你主动导出。",
    language: "English",
    annotatorId: "标注员 ID",
    annotatorPlaceholder: "例如 ann-01",
    exportJson: "导出 JSON",
    exportCsv: "导出 CSV",
    task: "任务",
    taskGuidance: "请结合完整轨迹上下文判断当前对齐步骤；系统分数和标签不会展示给标注员。",
    alignedSteps: "对齐轨迹步骤",
    selectAnyStep: "选择任一步",
    saved: "已保存",
    open: "未保存",
    stepJudgment: "步骤判断",
    unsaved: "未保存",
    formGuidance: "先判断 Run A 和 Run B 在 GUI 状态与动作意图上是否重叠；只有当前后帧和公开输出支持时，再选择分叉、缺失或回归。",
    runAPrevCurrentNext: "Run A 上一步 / 当前 / 下一步",
    runBPrevCurrentNext: "Run B 上一步 / 当前 / 下一步",
    frameUnavailable: "无可用截图",
    missingCounterpart: "缺失对应步",
    observableStep: "可观察步骤",
    missingOrEnd: "缺失 / 结束",
    scoringEvidence: "判断依据",
    currentNext: "当前 + 下一步",
    evidenceBoundary: "只使用这里展示的公开可观察输出/理由摘录；不要推断私有思维链。",
    noReleasedOutput: "无公开输出摘录。",
    labels: {
      overlap: "重叠",
      diverged: "分叉",
      missing_a: "A 缺失",
      missing_b: "B 缺失",
      rejoined: "回归",
      unsure: "不确定",
    },
    severity: "严重程度",
    severityOptions: ["0：相同 / 无问题", "1：轻微差异", "2：有意义分叉", "3：严重分叉"],
    laterOutcome: "后续结果",
    outcomeOptions: { rejoined: "回归", persistent: "持续分叉", unsure: "不确定" },
    notes: "备注",
    previous: "上一条",
    saveNext: "保存并下一条",
    savedHistory: "保存历史",
    localRecords: "条本地记录",
    savedProgress: "已保存",
    noHistory: "还没有本地标注。点击保存并下一条后会生成你自己的可导出记录。",
    loading: "正在加载标注项...",
    loadedSuffix: "个对齐步骤已从真实/备用轨迹对加载。",
  },
} satisfies Record<ExperimentLanguage, Record<string, unknown>>;

function frameAlt(trace: GuiAgentTrace, step: GuiAgentTraceStep | null): string {
  return `${traceLabel(trace)} step ${step?.stepIndex ?? "missing"}`;
}

function nextStep(trace: GuiAgentTrace, step: GuiAgentTraceStep | null): GuiAgentTraceStep | null {
  if (!step) return null;
  return trace.steps.find((candidate) => candidate.stepIndex > step.stepIndex) ?? null;
}

function releasedReason(step: GuiAgentTraceStep | null, t: typeof copy.en): string {
  if (!step) return t.missingCounterpart as string;
  return shortText(
    [
      step.agentOutputExcerpt ? `output: ${step.agentOutputExcerpt}` : "",
      step.structuredRationale ? `released rationale: ${step.structuredRationale}` : "",
    ]
      .filter(Boolean)
      .join(" / ") || (t.noReleasedOutput as string),
    220,
  ) || (t.noReleasedOutput as string);
}

function StepContext({
  title,
  trace,
  currentStep,
  t,
}: {
  title: string;
  trace: GuiAgentTrace;
  currentStep: GuiAgentTraceStep | null;
  t: typeof copy.en;
}) {
  const context = getStepContext(trace, currentStep);
  const [hoveredFrame, setHoveredFrame] = useState<{ src: string; label: string } | null>(null);
  return (
    <section className="experiment-card step-context">
      <div className="experiment-card-title">
        <span>{title}</span>
        <strong>{traceLabel(trace)}</strong>
      </div>
      <div className="context-triptych">
        {context.length ? (
          context.map((step) => {
            const image = displayableFrame(step);
            const isCurrent = step.stepIndex === currentStep?.stepIndex;
            const targetText = shortText(step.target.label || step.observationSummary, 120) || (t.observableStep as string);
            const stateText = shortText(step.stateAfter || step.observationSummary, 140) || (t.observableStep as string);
            return (
              <div className={isCurrent ? "context-frame current" : "context-frame"} key={step.stepIndex}>
                {image ? (
                  <img
                    alt={frameAlt(trace, step)}
                    onBlur={() => setHoveredFrame(null)}
                    onFocus={() => setHoveredFrame({ src: image, label: frameAlt(trace, step) })}
                    onMouseEnter={() => setHoveredFrame({ src: image, label: frameAlt(trace, step) })}
                    onMouseLeave={() => setHoveredFrame(null)}
                    src={image}
                    tabIndex={0}
                  />
                ) : (
                  <div className="frame-placeholder">{t.frameUnavailable as string}</div>
                )}
                <div className="step-mini">
                  <b>
                    {step.stepIndex}. {step.actionType}
                  </b>
                  <span>{targetText}</span>
                  <em>{stateText}</em>
                </div>
              </div>
            );
          })
        ) : (
          <div className="step-mini missing">{t.missingCounterpart as string}</div>
        )}
      </div>
      {hoveredFrame ? (
        <div className="frame-large-preview" role="status">
          <img alt={hoveredFrame.label} src={hoveredFrame.src} />
          <span>{hoveredFrame.label}</span>
        </div>
      ) : null}
    </section>
  );
}

function itemActionLabel(item: GoldItem): string {
  const a = item.comparison.textStep;
  const b = item.comparison.visionStep;
  return [
    a ? `A${a.stepIndex} ${a.actionType}` : "A missing",
    b ? `B${b.stepIndex} ${b.actionType}` : "B missing",
  ].join(" / ");
}

function itemTargetLabel(item: GoldItem): string {
  const a = item.comparison.textStep?.target.label;
  const b = item.comparison.visionStep?.target.label;
  return shortText([a, b].filter(Boolean).join(" | ") || "No target text", 80) || "observable step";
}

function EvidenceSummary({ item, t }: { item: GoldItem; t: typeof copy.en }) {
  const aCurrent = item.comparison.textStep;
  const bCurrent = item.comparison.visionStep;
  const aNext = nextStep(item.pair.runA, aCurrent);
  const bNext = nextStep(item.pair.runB, bCurrent);
  const evidenceRows: Array<[string, GuiAgentTraceStep | null]> = [
    ["Run A current", aCurrent],
    ["Run B current", bCurrent],
    ["Run A next", aNext],
    ["Run B next", bNext],
  ];
  return (
    <section className="scoring-evidence" aria-label={t.scoringEvidence as string}>
      <div className="experiment-card-title">
        <span>{t.scoringEvidence as string}</span>
        <strong>{t.currentNext as string}</strong>
      </div>
      <div className="evidence-mini-grid">
        {evidenceRows.map(([label, step]) => (
          <div className="evidence-mini" key={label}>
            <b>{label}</b>
            <span>
              {step
                ? `${step.stepIndex}. ${step.actionType} · ${shortText(step.target.label || step.observationSummary, 80) || (t.observableStep as string)}`
                : (t.missingOrEnd as string)}
            </span>
            <em>{releasedReason(step, t)}</em>
          </div>
        ))}
      </div>
      <p className="evidence-boundary">{t.evidenceBoundary as string}</p>
    </section>
  );
}

export function HumanGoldSubsetApp() {
  const [language, setLanguage] = useState<ExperimentLanguage>("en");
  const [annotatorId, setAnnotatorId] = useState("");
  const [items, setItems] = useState<GoldItem[]>([]);
  const [index, setIndex] = useState(0);
  const [records, setRecords] = useState<GoldAnnotationRecord[]>(() => loadRecords<GoldAnnotationRecord>(storageKey));
  const [status, setStatus] = useState("Loading trajectory pairs...");
  const [form, setForm] = useState(emptyForm);

  const item = items[index];
  const existingRecord = useMemo(() => records.find((record) => record.itemId === item?.itemId), [item?.itemId, records]);
  const currentPairItems = useMemo(
    () =>
      item
        ? items
            .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
            .filter(({ candidate }) => candidate.pair.pairId === item.pair.pairId)
        : [],
    [item, items],
  );

  useEffect(() => {
    clearLegacyRecords(legacyStorageKeys);
    let cancelled = false;
    async function load() {
      const pairs = await loadExperimentPairs(24);
      if (cancelled) return;
      const nextItems = buildGoldItems(pairs, 240);
      setItems(nextItems);
      setStatus(`${nextItems.length} aligned steps loaded from ${pairs.length} real/fallback pairs.`);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!existingRecord) {
      setForm(emptyForm);
      return;
    }
    setForm({
      label: existingRecord.label,
      severity: existingRecord.severity,
      laterOutcome: existingRecord.laterOutcome,
      notes: existingRecord.notes,
    });
  }, [existingRecord]);

  function saveCurrent(nextIndex = index + 1) {
    if (!item) return;
    const now = new Date().toISOString();
    const targetIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
    const record: GoldAnnotationRecord = {
      schemaVersion: "tracefork-human-gold-v1",
      annotatorId: annotatorId.trim() || "anonymous-annotator",
      itemId: item.itemId,
      pairId: item.pair.pairId,
      taskId: item.pair.task.taskId,
      runAId: item.pair.runA.traceId,
      runBId: item.pair.runB.traceId,
      aStepIndex: item.comparison.textStep?.stepIndex ?? null,
      bStepIndex: item.comparison.visionStep?.stepIndex ?? null,
      label: form.label,
      severity: form.severity,
      laterOutcome: form.laterOutcome,
      firstForkStepA: null,
      firstForkStepB: null,
      rejoinStepA: null,
      rejoinStepB: null,
      notes: form.notes.trim(),
      createdAt: existingRecord?.createdAt ?? now,
      updatedAt: now,
    };
    setRecords((currentRecords) => {
      const nextRecords = [...currentRecords.filter((candidate) => candidate.itemId !== item.itemId), record];
      saveRecords(storageKey, nextRecords);
      return nextRecords;
    });
    setIndex(targetIndex);
  }

  function exportJson() {
    downloadText("tracefork-human-gold-annotations.json", JSON.stringify(records, null, 2));
  }

  function exportCsv() {
    downloadText("tracefork-human-gold-annotations.csv", recordsToCsv(records as unknown as Array<Record<string, unknown>>), "text/csv");
  }

  function jumpToRecord(record: GoldAnnotationRecord) {
    const nextIndex = items.findIndex((candidate) => candidate.itemId === record.itemId);
    if (nextIndex >= 0) setIndex(nextIndex);
  }

  const itemIds = useMemo(() => new Set(items.map((candidate) => candidate.itemId)), [items]);
  const completed = useMemo(
    () => new Set(records.filter((record) => itemIds.has(record.itemId)).map((record) => record.itemId)).size,
    [itemIds, records],
  );
  const currentPosition = items.length ? Math.min(items.length, index + 1) : 0;
  const recentRecords = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  const t = copy[language] as typeof copy.en;
  const labelCopy = t.labels as Record<GoldAnnotationRecord["label"], string>;
  const outcomeCopy = t.outcomeOptions as Record<GoldAnnotationRecord["laterOutcome"], string>;
  const severityOptions = t.severityOptions as string[];

  return (
    <main className="experiment-shell">
      <header className="experiment-header">
        <a href="./">TraceFork</a>
        <div>
          <div className="experiment-title-row">
            <span>{t.experiment as string}</span>
            <button className="language-toggle" type="button" onClick={() => setLanguage((current) => (current === "en" ? "zh" : "en"))}>
              {t.language as string}
            </button>
          </div>
          <h1>{t.title as string}</h1>
          <p>{t.subtitle as string}</p>
        </div>
      </header>

      <section className="experiment-toolbar">
        <label>
          {t.annotatorId as string}
          <input value={annotatorId} onChange={(event) => setAnnotatorId(event.currentTarget.value)} placeholder={t.annotatorPlaceholder as string} />
        </label>
        <div className="progress-meter">
          <strong>
            {currentPosition}/{items.length || 0}
          </strong>
          <span>
            {t.savedProgress as string} {completed}/{items.length || 0} · {status}
          </span>
        </div>
        <button type="button" onClick={exportJson} disabled={records.length === 0}>
          {t.exportJson as string}
        </button>
        <button type="button" onClick={exportCsv} disabled={records.length === 0}>
          {t.exportCsv as string}
        </button>
      </section>

      {item ? (
        <div className="annotation-layout">
          <section className="experiment-card task-card">
            <span>{t.task as string}</span>
            <h2>{item.pair.task.instruction}</h2>
            <p>
              {t.taskGuidance as string} Step {index + 1}/{items.length}.
            </p>
          </section>

          <section className="experiment-card alignment-list-card">
            <div className="experiment-card-title">
              <span>{t.alignedSteps as string}</span>
              <strong>{t.selectAnyStep as string}</strong>
            </div>
            <div className="alignment-step-list" aria-label="Aligned trajectory steps">
              {currentPairItems.map(({ candidate, candidateIndex }) => {
                const saved = records.some((record) => record.itemId === candidate.itemId);
                return (
                  <button
                    className={`${candidate.itemId === item.itemId ? "active" : ""} ${saved ? "saved" : ""}`}
                    key={candidate.itemId}
                    type="button"
                    onClick={() => setIndex(candidateIndex)}
                  >
                    <b>{itemActionLabel(candidate)}</b>
                    <span>{itemTargetLabel(candidate)}</span>
                    <em>{saved ? (t.saved as string) : (t.open as string)}</em>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="gold-step-detail">
            <StepContext title={t.runAPrevCurrentNext as string} trace={item.pair.runA} currentStep={item.comparison.textStep} t={t} />
            <StepContext title={t.runBPrevCurrentNext as string} trace={item.pair.runB} currentStep={item.comparison.visionStep} t={t} />
          </div>

          <section className="experiment-card form-card">
            <div className="experiment-card-title">
              <span>{t.stepJudgment as string}</span>
              <strong>{existingRecord ? (t.saved as string) : (t.unsaved as string)}</strong>
            </div>
            <p className="form-guidance">
              {t.formGuidance as string}
            </p>
            <EvidenceSummary item={item} t={t} />
            <div className="choice-grid">
              {(["overlap", "diverged", "missing_a", "missing_b", "rejoined", "unsure"] as const).map((label) => (
                <button
                  className={form.label === label ? "choice active" : "choice"}
                  key={label}
                  type="button"
                  onClick={() => setForm((current) => ({ ...current, label }))}
                >
                  {labelCopy[label]}
                </button>
              ))}
            </div>
            <label className="range-field">
              {t.severity as string}
              <select
                value={form.severity}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value) as 0 | 1 | 2 | 3;
                  setForm((current) => ({ ...current, severity: value }));
                }}
              >
                <option value={0}>{severityOptions[0]}</option>
                <option value={1}>{severityOptions[1]}</option>
                <option value={2}>{severityOptions[2]}</option>
                <option value={3}>{severityOptions[3]}</option>
              </select>
            </label>
            <label className="range-field">
              {t.laterOutcome as string}
              <select
                value={form.laterOutcome}
                onChange={(event) => {
                  const value = event.currentTarget.value as GoldAnnotationRecord["laterOutcome"];
                  setForm((current) => ({ ...current, laterOutcome: value }));
                }}
              >
                <option value="rejoined">{outcomeCopy.rejoined}</option>
                <option value="persistent">{outcomeCopy.persistent}</option>
                <option value="unsure">{outcomeCopy.unsure}</option>
              </select>
            </label>
            <label className="notes-field">
              {t.notes as string}
              <textarea
                value={form.notes}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setForm((current) => ({ ...current, notes: value }));
                }}
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setIndex(Math.max(0, index - 1))}>
                {t.previous as string}
              </button>
              <button type="button" className="primary-action" onClick={() => saveCurrent()}>
                {t.saveNext as string}
              </button>
            </div>
            <div className="local-history">
              <div className="experiment-card-title">
                <span>{t.savedHistory as string}</span>
                <strong>
                  {records.length} {t.localRecords as string}
                </strong>
              </div>
              {recentRecords.length ? (
                <div className="history-list">
                  {recentRecords.map((record) => (
                    <button key={record.itemId} type="button" onClick={() => jumpToRecord(record)}>
                      <b>{labelCopy[record.label]}</b>
                      <span>
                        {t.severity as string} {record.severity} · A {record.aStepIndex ?? "-"} / B {record.bStepIndex ?? "-"}
                      </span>
                      <em>{new Date(record.updatedAt).toLocaleString()}</em>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="history-empty">{t.noHistory as string}</p>
              )}
            </div>
          </section>
        </div>
      ) : (
        <section className="experiment-card task-card">
          <h2>{t.loading as string}</h2>
          <p>{status}</p>
        </section>
      )}
    </main>
  );
}
