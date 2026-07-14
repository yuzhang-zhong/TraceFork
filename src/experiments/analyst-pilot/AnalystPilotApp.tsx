import { useEffect, useMemo, useState } from "react";
import "../shared/experimentStyles.css";
import {
  buildPilotTrials,
  clearLegacyRecords,
  displayableFrame,
  downloadText,
  loadExperimentPairs,
  loadRecords,
  recordsToCsv,
  saveRecords,
  shortText,
  traceLabel,
  type ExperimentCondition,
  type PilotTrial,
  type PilotTrialRecord,
} from "../shared/experimentData.js";
import type { GuiAgentTrace, GuiAgentTraceStep, GuiTraceStepComparison } from "../../projectTypes.js";

const legacyStorageKeys = ["tracefork-analyst-pilot-responses-v1"];
const storageKey = "tracefork-analyst-pilot-annotation-tool-v2";

const emptyForm = {
  firstForkStepA: "",
  firstForkStepB: "",
  rejoinJudgment: "unsure" as PilotTrialRecord["rejoinJudgment"],
  mainCause: "unsure" as PilotTrialRecord["mainCause"],
  confidence: 3,
  usefulness: 3,
  mentalEffort: 3,
  feedback: "",
};

type ExperimentLanguage = "en" | "zh";

const pilotCopy = {
  en: {
    experiment: "Annotation tool",
    title: "Analyst walkthrough annotation tool",
    subtitle: "Create your own same-task trajectory judgments with raw-artifact and TraceFork-supported views. Records stay in this browser until exported.",
    language: "中文",
    participantId: "Participant ID",
    participantPlaceholder: "e.g. p-01",
    condition: "Condition",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    task: "Task",
    trial: "Trial",
    traceforkView: "TraceFork view",
    persistentSplit: "persistent split",
    noRejoin: "no rejoin",
    rawArtifactView: "Raw artifact view",
    sideBySideLogs: "side-by-side logs",
    observableStep: "observable step",
    initialFrames: "Initial frames",
    observableEvidenceOnly: "observable evidence only",
    frameUnavailable: "frame unavailable",
    analystJudgment: "Analyst judgment",
    saved: "saved",
    unsaved: "unsaved",
    firstForkA: "First split step A",
    firstForkB: "First split step B",
    forkHelp:
      "Split/fork means the first point where the two same-task trajectories stop matching in observable action, target, or page state. It is not itself a task-success or failure label.",
    didRejoin: "Did the paths rejoin?",
    mainCause: "Main cause",
    feedback: "Feedback",
    previous: "Previous",
    saveNext: "Save and next",
    savedHistory: "Saved history",
    localRecords: "local record(s)",
    savedProgress: "saved",
    noHistory: "No local annotations yet. Click Save and next to create your own exportable records.",
    loading: "Loading pilot trials...",
    fields: { confidence: "confidence", usefulness: "usefulness", mentalEffort: "mental effort" },
    rejoin: { yes: "yes", no: "no", unsure: "unsure" },
    causes: {
      action: "action",
      target: "target",
      state: "state",
      visual: "visual",
      missing_metadata: "missing metadata",
      unsure: "unsure",
    },
  },
  zh: {
    experiment: "标注工具",
    title: "分析员 Walkthrough 标注工具",
    subtitle: "使用原始日志视图和 TraceFork 辅助视图创建你自己的同任务轨迹判断。记录只保存在当前浏览器，直到你主动导出。",
    language: "English",
    participantId: "参与者 ID",
    participantPlaceholder: "例如 p-01",
    condition: "条件",
    exportJson: "导出 JSON",
    exportCsv: "导出 CSV",
    task: "任务",
    trial: "试次",
    traceforkView: "TraceFork 视图",
    persistentSplit: "持续分叉",
    noRejoin: "无回归",
    rawArtifactView: "原始日志视图",
    sideBySideLogs: "并排日志",
    observableStep: "可观察步骤",
    initialFrames: "初始截图",
    observableEvidenceOnly: "仅可观察证据",
    frameUnavailable: "无可用截图",
    analystJudgment: "分析员判断",
    saved: "已保存",
    unsaved: "未保存",
    firstForkA: "A 首次分叉步骤",
    firstForkB: "B 首次分叉步骤",
    forkHelp: "这里的分叉指同一任务下两条轨迹首次在可观察动作、目标或页面状态上不再匹配；它本身不等同于任务成功或失败。",
    didRejoin: "路径是否回归？",
    mainCause: "主要原因",
    feedback: "反馈",
    previous: "上一条",
    saveNext: "保存并下一条",
    savedHistory: "保存历史",
    localRecords: "条本地记录",
    savedProgress: "已保存",
    noHistory: "还没有本地标注。点击保存并下一条后会生成你自己的可导出记录。",
    loading: "正在加载 pilot 试次...",
    fields: { confidence: "信心", usefulness: "有用性", mentalEffort: "认知负担" },
    rejoin: { yes: "是", no: "否", unsure: "不确定" },
    causes: {
      action: "动作",
      target: "目标",
      state: "状态",
      visual: "视觉",
      missing_metadata: "元数据缺失",
      unsure: "不确定",
    },
  },
} satisfies Record<ExperimentLanguage, Record<string, unknown>>;

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function causeFromComparison(comparison: GuiTraceStepComparison): string {
  const parts: string[] = [];
  if (comparison.actionTypeDiff > 0.2) parts.push("action");
  if (comparison.targetElementDiff > 0.35) parts.push("target");
  if (comparison.stateSemanticDistance > 0.35 || comparison.stateTransitionDiff > 0.35) parts.push("state");
  if (comparison.screenRegionDistance > 0.35) parts.push("region");
  return parts.length ? parts.join(" + ") : "near-shared";
}

function frameAlt(trace: GuiAgentTrace, step: GuiAgentTraceStep | undefined, label: string): string {
  return `${label} ${traceLabel(trace)} step ${step?.stepIndex ?? "missing"}`;
}

function TraceForkEvidence({ trial, t }: { trial: PilotTrial; t: typeof pilotCopy.en }) {
  const rows = trial.pair.analysis.comparisons.slice(0, 14);
  return (
    <section className="experiment-card evidence-card">
      <div className="experiment-card-title">
        <span>{t.traceforkView as string}</span>
        <strong>
          {trial.pair.analysis.persistentDivergence
            ? (t.persistentSplit as string)
            : trial.pair.analysis.rejoinStep
              ? `rejoin ${trial.pair.analysis.rejoinStep}`
              : (t.noRejoin as string)}
        </strong>
      </div>
      <div className="comparison-strip">
        {rows.map((comparison) => (
          <div className={`comparison-chip event-${comparison.event}`} key={comparison.stepIndex}>
            <b>{comparison.stepIndex}</b>
            <span>{Math.round(comparison.divergenceScore * 100)}%</span>
            <em>{causeFromComparison(comparison)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function RawLogEvidence({ trial, t }: { trial: PilotTrial; t: typeof pilotCopy.en }) {
  return (
    <section className="experiment-card evidence-card">
      <div className="experiment-card-title">
        <span>{t.rawArtifactView as string}</span>
        <strong>{t.sideBySideLogs as string}</strong>
      </div>
      <div className="raw-log-grid">
        {[trial.pair.runA, trial.pair.runB].map((trace, traceIndex) => (
          <div className="raw-log-column" key={trace.traceId}>
            <b>{traceIndex === 0 ? "Run A" : "Run B"} · {traceLabel(trace)}</b>
            {trace.steps.slice(0, 18).map((step) => (
              <div className="raw-step" key={step.stepIndex}>
                <span>
                  {step.stepIndex}. {step.actionType}
                </span>
                <em>{shortText(step.target.label || step.observationSummary, 90) || (t.observableStep as string)}</em>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function FramePreview({ trial, t }: { trial: PilotTrial; t: typeof pilotCopy.en }) {
  const [hoveredFrame, setHoveredFrame] = useState<{ src: string; label: string } | null>(null);
  const aStep = trial.pair.runA.steps[0];
  const bStep = trial.pair.runB.steps[0];
  const aFrame = displayableFrame(aStep);
  const bFrame = displayableFrame(bStep);
  return (
    <section className="experiment-card frame-preview-card">
      <div className="experiment-card-title">
        <span>{t.initialFrames as string}</span>
        <strong>{t.observableEvidenceOnly as string}</strong>
      </div>
      <div className="pilot-frame-grid">
        {aFrame ? (
          <img
            alt={frameAlt(trial.pair.runA, aStep, "Run A initial frame")}
            onBlur={() => setHoveredFrame(null)}
            onFocus={() => setHoveredFrame({ src: aFrame, label: frameAlt(trial.pair.runA, aStep, "Run A initial frame") })}
            onMouseEnter={() => setHoveredFrame({ src: aFrame, label: frameAlt(trial.pair.runA, aStep, "Run A initial frame") })}
            onMouseLeave={() => setHoveredFrame(null)}
            src={aFrame}
            tabIndex={0}
          />
        ) : (
          <div className="frame-placeholder">Run A {t.frameUnavailable as string}</div>
        )}
        {bFrame ? (
          <img
            alt={frameAlt(trial.pair.runB, bStep, "Run B initial frame")}
            onBlur={() => setHoveredFrame(null)}
            onFocus={() => setHoveredFrame({ src: bFrame, label: frameAlt(trial.pair.runB, bStep, "Run B initial frame") })}
            onMouseEnter={() => setHoveredFrame({ src: bFrame, label: frameAlt(trial.pair.runB, bStep, "Run B initial frame") })}
            onMouseLeave={() => setHoveredFrame(null)}
            src={bFrame}
            tabIndex={0}
          />
        ) : (
          <div className="frame-placeholder">Run B {t.frameUnavailable as string}</div>
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

export function AnalystPilotApp() {
  const [language, setLanguage] = useState<ExperimentLanguage>("en");
  const [participantId, setParticipantId] = useState("");
  const [trials, setTrials] = useState<PilotTrial[]>([]);
  const [index, setIndex] = useState(0);
  const [condition, setCondition] = useState<ExperimentCondition>("tracefork");
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const [records, setRecords] = useState<PilotTrialRecord[]>(() => loadRecords<PilotTrialRecord>(storageKey));
  const [status, setStatus] = useState("Loading pilot trials...");
  const [form, setForm] = useState(emptyForm);

  const trial = trials[index];
  const existingRecord = useMemo(() => records.find((record) => record.trialId === trial?.trialId && record.condition === condition), [condition, records, trial?.trialId]);

  useEffect(() => {
    clearLegacyRecords(legacyStorageKeys);
    let cancelled = false;
    async function load() {
      const pairs = await loadExperimentPairs(32);
      if (cancelled) return;
      const nextTrials = buildPilotTrials(pairs, 32);
      setTrials(nextTrials);
      setCondition(nextTrials[0]?.recommendedCondition ?? "tracefork");
      setStatus(`${nextTrials.length} analyst trials loaded from ${pairs.length} real/fallback pairs.`);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setStartedAt(new Date().toISOString());
  }, [index, condition]);

  useEffect(() => {
    if (!existingRecord) {
      setForm(emptyForm);
      return;
    }
    setForm({
      firstForkStepA: existingRecord.firstForkStepA == null ? "" : String(existingRecord.firstForkStepA),
      firstForkStepB: existingRecord.firstForkStepB == null ? "" : String(existingRecord.firstForkStepB),
      rejoinJudgment: existingRecord.rejoinJudgment,
      mainCause: existingRecord.mainCause,
      confidence: existingRecord.confidence,
      usefulness: existingRecord.usefulness,
      mentalEffort: existingRecord.mentalEffort,
      feedback: existingRecord.feedback,
    });
  }, [existingRecord]);

  function saveCurrent(nextIndex = index + 1) {
    if (!trial) return;
    const submittedAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.parse(submittedAt) - Date.parse(startedAt));
    const targetIndex = Math.max(0, Math.min(trials.length - 1, nextIndex));
    const record: PilotTrialRecord = {
      schemaVersion: "tracefork-analyst-pilot-v1",
      participantId: participantId.trim() || "anonymous-participant",
      trialId: trial.trialId,
      pairId: trial.pair.pairId,
      taskId: trial.pair.task.taskId,
      runAId: trial.pair.runA.traceId,
      runBId: trial.pair.runB.traceId,
      condition,
      startedAt,
      submittedAt,
      elapsedMs,
      firstForkStepA: parseOptionalNumber(form.firstForkStepA),
      firstForkStepB: parseOptionalNumber(form.firstForkStepB),
      rejoinJudgment: form.rejoinJudgment,
      mainCause: form.mainCause,
      confidence: form.confidence,
      usefulness: form.usefulness,
      mentalEffort: form.mentalEffort,
      feedback: form.feedback.trim(),
    };
    setRecords((currentRecords) => {
      const nextRecords = [
        ...currentRecords.filter((candidate) => !(candidate.trialId === trial.trialId && candidate.condition === condition)),
        record,
      ];
      saveRecords(storageKey, nextRecords);
      return nextRecords;
    });
    setIndex(targetIndex);
    setCondition(trials[targetIndex]?.recommendedCondition ?? condition);
  }

  function exportJson() {
    downloadText("tracefork-analyst-pilot-records.json", JSON.stringify(records, null, 2));
  }

  function exportCsv() {
    downloadText("tracefork-analyst-pilot-records.csv", recordsToCsv(records as unknown as Array<Record<string, unknown>>), "text/csv");
  }

  function jumpToRecord(record: PilotTrialRecord) {
    const nextIndex = trials.findIndex((candidate) => candidate.trialId === record.trialId);
    if (nextIndex >= 0) {
      setIndex(nextIndex);
      setCondition(record.condition);
    }
  }

  function updateConditionPreservingScroll(nextCondition: ExperimentCondition) {
    const scrollY = window.scrollY;
    setCondition(nextCondition);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY, left: window.scrollX });
    });
  }

  const recentRecords = [...records].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 12);
  const trialIds = useMemo(() => new Set(trials.map((candidate) => candidate.trialId)), [trials]);
  const completed = useMemo(
    () =>
      new Set(
        records
          .filter((record) => trialIds.has(record.trialId))
          .map((record) => `${record.trialId}::${record.condition}`),
      ).size,
    [records, trialIds],
  );
  const currentPosition = trials.length ? Math.min(trials.length, index + 1) : 0;
  const totalConditionSlots = trials.length * 2;
  const t = pilotCopy[language] as typeof pilotCopy.en;
  const fieldCopy = t.fields as Record<"confidence" | "usefulness" | "mentalEffort", string>;
  const rejoinCopy = t.rejoin as Record<PilotTrialRecord["rejoinJudgment"], string>;
  const causeCopy = t.causes as Record<PilotTrialRecord["mainCause"], string>;

  return (
    <main className="experiment-shell pilot-shell">
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
          {t.participantId as string}
          <input
            aria-label={t.participantId as string}
            name="participantId"
            value={participantId}
            onChange={(event) => setParticipantId(event.currentTarget.value)}
            placeholder={t.participantPlaceholder as string}
          />
        </label>
        <label>
          {t.condition as string}
          <select
            aria-label={t.condition as string}
            name="condition"
            value={condition}
            onChange={(event) => updateConditionPreservingScroll(event.currentTarget.value as ExperimentCondition)}
          >
            <option value="tracefork">TraceFork</option>
            <option value="raw_logs">Raw logs</option>
          </select>
        </label>
        <div className="progress-meter">
          <strong>
            {currentPosition}/{trials.length || 0}
          </strong>
          <span>
            {t.savedProgress as string} {completed}/{totalConditionSlots || 0} · {status}
          </span>
        </div>
        <button type="button" onClick={exportJson} disabled={records.length === 0}>
          {t.exportJson as string}
        </button>
        <button type="button" onClick={exportCsv} disabled={records.length === 0}>
          {t.exportCsv as string}
        </button>
      </section>

      {trial ? (
        <div className="pilot-layout">
          <section className="experiment-card task-card">
            <span>{t.task as string}</span>
            <h2>{trial.pair.task.instruction}</h2>
            <p>
              {t.trial as string} {index + 1}/{trials.length} · Run A: {traceLabel(trial.pair.runA)} · Run B: {traceLabel(trial.pair.runB)}
            </p>
          </section>

          {condition === "tracefork" ? <TraceForkEvidence trial={trial} t={t} /> : <RawLogEvidence trial={trial} t={t} />}
          <FramePreview trial={trial} t={t} />

          <section className="experiment-card form-card">
            <div className="experiment-card-title">
              <span>{t.analystJudgment as string}</span>
              <strong>{existingRecord ? (t.saved as string) : (t.unsaved as string)}</strong>
            </div>
            <div className="numeric-grid">
              <div className="form-field">
                <label htmlFor="pilot-first-split-a">{t.firstForkA as string}</label>
                <input
                  id="pilot-first-split-a"
                  inputMode="numeric"
                  min={0}
                  name="firstSplitStepA"
                  step={1}
                  type="number"
                  value={form.firstForkStepA}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setForm((current) => ({ ...current, firstForkStepA: value }));
                  }}
                />
              </div>
              <div className="form-field">
                <label htmlFor="pilot-first-split-b">{t.firstForkB as string}</label>
                <input
                  id="pilot-first-split-b"
                  inputMode="numeric"
                  min={0}
                  name="firstSplitStepB"
                  step={1}
                  type="number"
                  value={form.firstForkStepB}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setForm((current) => ({ ...current, firstForkStepB: value }));
                  }}
                />
              </div>
            </div>
            <p className="form-help">{t.forkHelp as string}</p>
            <div className="form-field range-field">
              <label htmlFor="pilot-rejoin-judgment">{t.didRejoin as string}</label>
              <select
                id="pilot-rejoin-judgment"
                name="rejoinJudgment"
                value={form.rejoinJudgment}
                onChange={(event) => {
                  const value = event.currentTarget.value as PilotTrialRecord["rejoinJudgment"];
                  setForm((current) => ({ ...current, rejoinJudgment: value }));
                }}
              >
                <option value="yes">{rejoinCopy.yes}</option>
                <option value="no">{rejoinCopy.no}</option>
                <option value="unsure">{rejoinCopy.unsure}</option>
              </select>
            </div>
            <div className="form-field range-field">
              <label htmlFor="pilot-main-cause">{t.mainCause as string}</label>
              <select
                id="pilot-main-cause"
                name="mainCause"
                value={form.mainCause}
                onChange={(event) => {
                  const value = event.currentTarget.value as PilotTrialRecord["mainCause"];
                  setForm((current) => ({ ...current, mainCause: value }));
                }}
              >
                <option value="action">{causeCopy.action}</option>
                <option value="target">{causeCopy.target}</option>
                <option value="state">{causeCopy.state}</option>
                <option value="visual">{causeCopy.visual}</option>
                <option value="missing_metadata">{causeCopy.missing_metadata}</option>
                <option value="unsure">{causeCopy.unsure}</option>
              </select>
            </div>
            {(["confidence", "usefulness", "mentalEffort"] as const).map((field) => (
              <div className="slider-field" key={field}>
                <label htmlFor={`pilot-${field}`}>{fieldCopy[field]}: <b>{form[field]}</b></label>
                <input
                  id={`pilot-${field}`}
                  name={field}
                  type="range"
                  min={1}
                  max={5}
                  value={form[field]}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    setForm((current) => ({ ...current, [field]: value }));
                  }}
                />
              </div>
            ))}
            <div className="form-field notes-field">
              <label htmlFor="pilot-feedback">{t.feedback as string}</label>
              <textarea
                id="pilot-feedback"
                name="feedback"
                value={form.feedback}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setForm((current) => ({ ...current, feedback: value }));
                }}
              />
            </div>
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
                  {completed} {t.localRecords as string}
                </strong>
              </div>
              {recentRecords.length ? (
                <div className="history-list">
                  {recentRecords.map((record) => (
                    <button key={`${record.trialId}-${record.condition}`} type="button" onClick={() => jumpToRecord(record)}>
                      <b>{record.condition}</b>
                      <span>
                        split A {record.firstForkStepA ?? "-"} / B {record.firstForkStepB ?? "-"} · rejoin {rejoinCopy[record.rejoinJudgment]}
                      </span>
                      <em>{new Date(record.submittedAt).toLocaleString()}</em>
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
