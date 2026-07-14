import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { guiAgentTasks } from "../projectData.js";
import { analyzeGuiAgentTraces } from "../projectLogic.js";
import { appendTraceToTask, buildSplitPathLayout, parsePastedTrajectory } from "../traceWorkbench.js";
import { diagnoseTask, rankDiagnosticRows } from "../traceDiagnostics.js";

describe("trace workbench", () => {
  it("indexes AgentDiagnose-style trajectory properties for retrieval", () => {
    const task = {
      ...guiAgentTasks[0],
      taskId: "diagnose-backtrack",
      instruction: "Find the newest listing, verify the result, and go back if the first path is wrong.",
      traces: [
        {
          ...guiAgentTasks[0].traces[0],
          traceId: "diagnose-run",
          steps: [
            {
              ...guiAgentTasks[0].traces[0].steps[0],
              structuredRationale: "First inspect the page and plan the next steps.",
              agentOutputExcerpt: "I will check the page, verify the result, and go back to try a different category if needed.",
              stateAfter: "search_page",
            },
            {
              ...guiAgentTasks[0].traces[0].steps[1],
              actionType: "navigate" as const,
              target: { ...guiAgentTasks[0].traces[0].steps[1].target, label: "go_back previous page" },
              structuredRationale: "The current page is wrong, so go back and try a different path.",
              stateAfter: "search_page",
            },
          ],
        },
      ],
    };

    const row = diagnoseTask(task);
    expect(row.scores.backtracking_exploration).toBeGreaterThanOrEqual(3);
    expect(row.scores.self_verification).toBeGreaterThan(1.5);
    expect(row.tags).toContain("backtracking_exploration");
  });

  it("ranks diagnostic rows by selected dimension and behavior terms", () => {
    const rows = [
      diagnoseTask({
        ...guiAgentTasks[0],
        taskId: "diagnose-login-loop",
        instruction: "Open login settings and verify the security page.",
        traces: [
          {
            ...guiAgentTasks[0].traces[0],
            traceId: "loop-run",
            steps: guiAgentTasks[0].traces[0].steps.slice(0, 3).map((step, index) => ({
              ...step,
              target: { ...step.target, label: index === 1 ? "login page" : step.target.label },
              observationSummary: `${step.observationSummary} login page visible`,
              stateAfter: index === 1 ? "login" : "search",
            })),
          },
        ],
      }),
      diagnoseTask({
        ...guiAgentTasks[1],
        taskId: "diagnose-low-match",
        instruction: "Read a simple static notice.",
      }),
    ];

    const ranked = rankDiagnosticRows(rows, {
      dimension: "state_transition",
      minScore: 2,
      pattern: "login",
    });

    expect(ranked.map((row) => row.taskId)).toEqual(["diagnose-login-loop"]);
  });

  it("parses a pasted single normalized trajectory and appends it to the selected task", () => {
    const task = guiAgentTasks[0];
    const parsed = parsePastedTrajectory(
      JSON.stringify({
        traceId: "pasted-gpt4",
        modelId: "GPT4 pasted",
        steps: [
          {
            stepIndex: 1,
            actionType: "click",
            target: { label: "Notifications", bbox: [48, 266, 172, 36] },
            observationSummary: "Notifications link visible",
            stateAfter: "notifications_panel_open",
          },
        ],
      }),
      task,
      "GPT4 pasted",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "single_trace") return;
    const nextTasks = appendTraceToTask(guiAgentTasks, task.taskId, parsed.trace);
    const nextTask = nextTasks.find((candidate) => candidate.taskId === task.taskId);
    expect(nextTask?.traces.some((trace) => trace.traceId === "pasted-gpt4")).toBe(true);
  });

  it("preserves real trajectory metadata from pasted normalized task bundles", () => {
    const task = guiAgentTasks[0];
    const parsed = parsePastedTrajectory(
      JSON.stringify({
        tasks: [
          {
            taskId: "webarena-0",
            title: "Task 0",
            benchmark: "webarena",
            taskNumericId: "0",
            site: "shopping",
            sourceCollection: "webarena_gpt4_8k_cot",
            traces: [
              {
                traceId: "gpt4-run",
                agentId: "gpt4",
                agentKind: "offline_run",
                modelId: "gpt4-0613-cot",
                actorType: "model",
                observationMode: "text",
                outcome: "failed",
                sourceCollection: "webarena_gpt4_8k_cot",
                steps: [
                  {
                    stepIndex: 1,
                    actionType: "click",
                    target: { label: "Reports", bbox: [10, 20, 80, 30] },
                    observationSummary: "Reports visible",
                    stateAfter: "reports",
                  },
                ],
              },
              {
                traceId: "gpt35-run",
                agentId: "gpt35",
                agentKind: "offline_run",
                modelId: "gpt3.5-turbo-0613-cot",
                actorType: "model",
                observationMode: "text",
                outcome: "failed",
                sourceCollection: "webarena_gpt35_16k_cot",
                steps: [
                  {
                    stepIndex: 1,
                    actionType: "click",
                    target: { label: "Dashboard", bbox: [10, 20, 80, 30] },
                    observationSummary: "Dashboard visible",
                    stateAfter: "dashboard",
                  },
                ],
              },
            ],
          },
        ],
      }),
      task,
      "bundle",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "task_bundle") return;
    expect(parsed.tasks[0].benchmark).toBe("webarena");
    expect(parsed.tasks[0].site).toBe("shopping");
    expect(parsed.tasks[0].traces[0].actorType).toBe("model");
    expect(parsed.tasks[0].traces[0].observationMode).toBe("text");
    expect(parsed.tasks[0].traces[0].outcome).toBe("failed");
    expect(parsed.tasks[0].traces[0].sourceCollection).toBe("webarena_gpt4_8k_cot");
  });

  it("parses raw pasted action logs without requiring an LLM key", () => {
    const task = guiAgentTasks[0];
    const parsed = parsePastedTrajectory(
      [
        "1. click [Notifications] at https://demo.local/settings",
        "2. click [Promotional emails toggle]",
        "3. click [Save changes]",
      ].join("\n"),
      task,
      "local-parser",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "single_trace") return;
    expect(parsed.trace.steps).toHaveLength(3);
    expect(parsed.trace.steps[0].actionType).toBe("click");
    expect(parsed.trace.steps[0].url).toBe("https://demo.local/settings");
    expect(parsed.trace.sourceWarnings?.[0]).toContain("Pasted text parser");
  });

  it("attaches pasted image refs to locally parsed trajectory steps", () => {
    const task = guiAgentTasks[0];
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const parsed = parsePastedTrajectory(
      [
        "image: " + dataUrl,
        "1. click [Issues]",
        "2. type [Search] \"homepage content\"",
      ].join("\n"),
      task,
      "local-image-parser",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "single_trace") return;
    expect(parsed.trace.steps[0]).toMatchObject({
      screenshotRef: dataUrl,
      thumbnailRef: dataUrl,
      visualFrameAvailable: true,
    });
    const comparison = analyzeGuiAgentTraces(task, task.traces[0], parsed.trace);
    const layout = buildSplitPathLayout(task, task.traces[0], parsed.trace, comparison);
    expect(layout.nodes.some((node) => node.imageB === dataUrl || node.imageA === dataUrl)).toBe(true);
  });

  it("accepts LLM-style wrapped trace JSON with screenshot fields", () => {
    const task = guiAgentTasks[0];
    const image = "https://example.com/frame.webp";
    const parsed = parsePastedTrajectory(
      JSON.stringify({
        trace: {
          traceId: "llm-trace",
          agentId: "llm",
          modelId: "OpenAI parsed",
          steps: [
            {
              stepIndex: 1,
              actionType: "click",
              target: { label: "Issue search", bbox: [10, 20, 100, 40] },
              observationSummary: "Issue search page",
              stateAfter: "issue-search",
              screenshotRef: image,
            },
          ],
        },
      }),
      task,
      "OpenAI parsed",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.mode !== "single_trace") return;
    expect(parsed.trace.traceId).toBe("llm-trace");
    expect(parsed.trace.steps[0].thumbnailRef).toBe(image);
    expect(parsed.trace.steps[0].visualFrameAvailable).toBe(true);
  });

  it("builds a split-path layout with capped readable divergence and tighter rejoin spacing", () => {
    const task = guiAgentTasks.find((candidate) => candidate.taskId === "settings-notifications");
    expect(task).toBeTruthy();
    if (!task) return;
    const traceA = task.traces[0];
    const traceB = task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const aNodes = layout.nodes.filter((node) => node.lane === "a");
    const bNodes = layout.nodes.filter((node) => node.lane === "b");
    const sharedNodes = layout.nodes.filter((node) => node.lane === "shared");

    expect(layout.nodes.some((node) => node.lane === "task")).toBe(true);
    expect(layout.edges.every((edge) => Math.abs(edge.toX - edge.fromX) < 620)).toBe(true);
    expect(aNodes.length).toBeGreaterThan(0);
    expect(bNodes.length).toBe(aNodes.length);
    expect(sharedNodes.length).toBeGreaterThanOrEqual(1);
    aNodes.forEach((aNode) => {
      const bNode = bNodes.find((candidate) => candidate.stepIndex === aNode.stepIndex);
      expect(bNode).toBeTruthy();
      if (!bNode) return;
      expect(Math.abs(bNode.x - aNode.x)).toBeGreaterThanOrEqual(aNode.width + 53.99);
    });
    layout.edges.forEach((edge) => {
      expect(edge.toY).toBeGreaterThan(edge.fromY);
    });

    const rejoin = analysis.rejoinStep;
    if (rejoin) {
      const aRejoin = layout.nodes.find((node) => node.id === `a-${rejoin}`);
      const bRejoin = layout.nodes.find((node) => node.id === `b-${rejoin}`);
      const sharedRejoin = layout.nodes.find((node) => node.id === `shared-${rejoin}`);
      const firstA = aNodes[0];
      const firstB = bNodes[0];
      expect(sharedRejoin || (aRejoin && bRejoin)).toBeTruthy();
      if (aRejoin && bRejoin) {
        expect(Math.abs(bRejoin.x - aRejoin.x)).toBeLessThan(Math.abs(firstB.x - firstA.x));
      }
    }
  });

  it("allows model paths to overlap before a later divergence", () => {
    const task = guiAgentTasks.find((candidate) => candidate.taskId === "support-order-refund-policy");
    expect(task).toBeTruthy();
    if (!task) return;
    const traceB = {
      ...task.traces[1],
      steps: task.traces[1].steps.map((step) =>
        step.stepIndex === 3
          ? {
              ...step,
              actionType: "type" as const,
              target: { ...step.target, label: "Shipping policy search box", bbox: [612, 386, 360, 42] as [number, number, number, number] },
              inputText: "shipping",
              stateAfter: "shipping_policy_search_active",
            }
          : step,
      ),
    };
    const analysis = analyzeGuiAgentTraces(task, task.traces[0], traceB);
    const layout = buildSplitPathLayout(task, task.traces[0], traceB, analysis);

    expect(analysis.comparisons[0].event).toBe("stable");
    expect(analysis.comparisons[1].event).toBe("stable");
    expect(analysis.comparisons[2].event).toBe("diverged");
    expect(layout.nodes.some((node) => node.id === "shared-1")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "shared-2")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "a-3")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "b-3")).toBe(true);

    const centerX = layout.width / 2;
    const sharedPrefixEdges = layout.edges.filter((edge) => Math.abs(edge.toX - centerX) <= 8);
    expect(sharedPrefixEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("realigns near-identical UI/action steps instead of forcing index-by-index divergence", () => {
    const baseStep = (stepIndex: number, actionType: "click" | "navigate", label: string, stateAfter: string, visualFingerprint: string) => ({
      stepIndex,
      observationType: "mixed" as const,
      observationSummary: `${label} visible on ${stateAfter}`,
      actionType,
      target: { label, bbox: [100, 120 + stepIndex * 20, 160, 36] as [number, number, number, number] },
      structuredRationale: `Observable ${actionType} on ${label}`,
      confidence: 0.8,
      stateAfter,
      thumbnailRef: `/trajectory-thumbnails/${visualFingerprint}.webp`,
      visualFingerprint,
    });
    const task = {
      taskId: "offset-overlap",
      title: "Offset overlap task",
      instruction: "Compare traces with one extra browser transition.",
      domain: "Synthetic GUI trace",
      startUrl: "https://example.test",
      successCriteria: "Same final UI should rejoin.",
      riskTags: ["test"],
      textState: "home",
      visualState: "home",
      screenshotSize: { width: 1280, height: 820 },
      traces: [
        {
          traceId: "run-a",
          agentId: "a",
          agentKind: "offline_run" as const,
          modelId: "run-a",
          taskId: "offset-overlap",
          steps: [
            baseStep(1, "click", "Search", "home", "home-frame"),
            baseStep(2, "navigate", "browser navigation", "results-loading", "loading-frame"),
            baseStep(3, "click", "Checkout", "cart-open", "cart-frame"),
          ],
        },
        {
          traceId: "run-b",
          agentId: "b",
          agentKind: "offline_run" as const,
          modelId: "run-b",
          taskId: "offset-overlap",
          steps: [baseStep(1, "click", "Search", "home", "home-frame"), baseStep(2, "click", "Checkout button", "cart-open", "cart-frame")],
        },
      ],
    };

    const analysis = analyzeGuiAgentTraces(task, task.traces[0], task.traces[1]);
    const layout = buildSplitPathLayout(task, task.traces[0], task.traces[1], analysis);

    expect(analysis.comparisons).toHaveLength(3);
    expect(analysis.comparisons[0].event).toBe("stable");
    expect(analysis.comparisons[1].visionStep).toBeNull();
    expect(analysis.comparisons[2].textStep?.stepIndex).toBe(3);
    expect(analysis.comparisons[2].visionStep?.stepIndex).toBe(2);
    expect(analysis.comparisons[2].event).toBe("rejoined");
    expect(layout.nodes.some((node) => node.id === "shared-1")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "a-2")).toBe(true);
    expect(layout.nodes.some((node) => node.id === "shared-3")).toBe(true);
  });

  it("carries run screenshots into left and right node corners", () => {
    const task = guiAgentTasks.find((candidate) => candidate.taskId === "settings-notifications");
    expect(task).toBeTruthy();
    if (!task) return;
    const traceA = {
      ...task.traces[0],
      steps: task.traces[0].steps.map((step) => ({ ...step, thumbnailRef: `/trajectory-thumbnails/a-${step.stepIndex}.png` })),
    };
    const traceB = {
      ...task.traces[1],
      steps: task.traces[1].steps.map((step) => ({ ...step, thumbnailRef: `/trajectory-thumbnails/b-${step.stepIndex}.png` })),
    };
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const firstShared = layout.nodes.find((node) => node.lane === "shared");
    const firstA = layout.nodes.find((node) => node.lane === "a");
    const firstB = layout.nodes.find((node) => node.lane === "b");

    expect(firstShared?.imageA ?? firstA?.imageA).toContain("/trajectory-thumbnails/a-");
    expect(firstShared?.imageB ?? firstB?.imageB).toContain("/trajectory-thumbnails/b-");
  });

  it("overlaps visually equivalent WebArena steps when one trace records the result as browser navigation", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-classifieds-162.json", "utf8"));
    const traceA = task.traces.find((trace: { modelId: string }) => trace.modelId === "gpt-4-vision-preview") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const fifthComparison = analysis.comparisons.find((comparison) => comparison.textStep?.stepIndex === 5 && comparison.visionStep?.stepIndex === 5);
    const fifthNode = layout.nodes.find((node) => node.id === "shared-5");

    expect(fifthComparison?.event).toMatch(/stable|rejoined/);
    expect(fifthComparison?.relation).toBe("matched");
    expect(fifthComparison?.contextSimilarity).toBeGreaterThanOrEqual(0.64);
    expect(fifthNode).toMatchObject({
      lane: "shared",
      imageA: expect.stringContaining("visual-webarena-gpt4-classifieds-162-5"),
      imageB: expect.stringContaining("visual-webarena-human-classifieds-162-5"),
    });
  });

  it("marks terminal model stops as failures without front-loading missing rows", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-reddit-169.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const first = analysis.comparisons[0];

    expect(first.textStep?.stepIndex).toBe(1);
    expect(first.visionStep).toBeTruthy();
    expect(first.divergenceType).toBe("agent_failure");
    expect(layout.markers[0]?.label).toBe("failure / stop");
    expect(layout.nodes.some((node) => node.lane === "a" && node.actionLabel.includes("failure"))).toBe(true);
  });

  it("does not mark answer-only stop actions as failures", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-classifieds-14.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const answerNode = layout.nodes.find((node) => /john\.dubois394@example\.com/i.test([node.detailTitle, node.agentNote].join(" ")));

    expect(answerNode).toBeTruthy();
    expect(answerNode?.title).not.toMatch(/failure/i);
    expect(answerNode?.actionLabel).not.toMatch(/failure/i);
  });

  it("does not promote generic same-page browser states into a false rejoin", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-classifieds-100.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const layout = buildSplitPathLayout(task, traceA, traceB, analysis);
    const blueTwoGreenThreeArea = analysis.comparisons.find((comparison) => comparison.textStep?.stepIndex === 2 || comparison.visionStep?.stepIndex === 3);

    expect(analysis.rejoinStep).toBeNull();
    expect(blueTwoGreenThreeArea?.event).toBe("diverged");
    expect(layout.nodes.some((node) => node.id === "shared-2" || node.id === "shared-3")).toBe(false);
  });

  it("keeps image-location refusal traces persistent instead of rejoining on generic frames", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-reddit-182.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);

    expect(analysis.rejoinStep).toBeNull();
    expect(analysis.persistentDivergence).toBe(true);
    expect(analysis.comparisons.some((comparison) => comparison.divergenceType === "agent_failure")).toBe(true);
    expect(analysis.comparisons.slice(0, 10).some((comparison) => comparison.event === "rejoined")).toBe(false);
  });

  it("keeps known VisualWebArena divergence points split instead of over-merging by step index", () => {
    const cases = [
      {
        taskPath: "public/trajectory-library/tasks/visualwebarena-classifieds-110.json",
        forbiddenSharedStep: 2,
        expectedPair: { textStep: 2, visionStep: 4 },
        expectedEvent: "diverged",
      },
      {
        taskPath: "public/trajectory-library/tasks/visualwebarena-classifieds-170.json",
        forbiddenSharedStep: 3,
        expectedTextExtra: 3,
      },
      {
        taskPath: "public/trajectory-library/tasks/visualwebarena-classifieds-21.json",
        expectedPair: { textStep: 3, visionStep: 8 },
        expectedEvent: "rejoined",
        expectedVisionExtra: 5,
      },
    ];

    cases.forEach((fixture) => {
      const task = JSON.parse(readFileSync(fixture.taskPath, "utf8"));
      const traceA = task.traces[0];
      const traceB = task.traces[1];
      const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
      const layout = buildSplitPathLayout(task, traceA, traceB, analysis);

      if (fixture.forbiddenSharedStep) {
        expect(layout.nodes.some((node) => node.id === `shared-${fixture.forbiddenSharedStep}`)).toBe(false);
      }
      if (fixture.expectedPair) {
        const pair = analysis.comparisons.find(
          (comparison) => comparison.textStep?.stepIndex === fixture.expectedPair.textStep && comparison.visionStep?.stepIndex === fixture.expectedPair.visionStep,
        );
        expect(pair?.event).toBe(fixture.expectedEvent);
      }
      if (fixture.expectedTextExtra) {
        expect(analysis.comparisons.some((comparison) => comparison.textStep?.stepIndex === fixture.expectedTextExtra && !comparison.visionStep)).toBe(true);
      }
      if (fixture.expectedVisionExtra) {
        expect(analysis.comparisons.some((comparison) => !comparison.textStep && comparison.visionStep?.stepIndex === fixture.expectedVisionExtra)).toBe(true);
      }
    });
  });

  it("keeps long one-sided human routes persistent instead of weakly rejoining late", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/webarena-335.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);

    expect(analysis.rejoinStep).toBeNull();
    expect(analysis.persistentDivergence).toBe(true);
    expect(analysis.comparisons.filter((comparison) => !comparison.textStep || !comparison.visionStep).length).toBeGreaterThanOrEqual(20);
    expect(analysis.comparisons.some((comparison) => comparison.event === "rejoined")).toBe(false);
  });

  it("renders repeated one-sided continuation as persistent drift rather than repeated new splits", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/visualwebarena-shopping-444.json", "utf8"));
    const traceA = task.traces.find((trace: { actorType: string }) => trace.actorType === "model") ?? task.traces[0];
    const traceB = task.traces.find((trace: { actorType: string }) => trace.actorType === "human") ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);
    const oneSidedRows = analysis.comparisons.filter((comparison) => !comparison.textStep || !comparison.visionStep);

    expect(analysis.rejoinStep).toBeNull();
    expect(oneSidedRows.length).toBeGreaterThanOrEqual(8);
    expect(oneSidedRows.slice(1).every((comparison) => comparison.event === "persistent_divergence")).toBe(true);
  });

  it("preserves clear short-prefix rejoins when later actions and states strongly match", () => {
    const task = JSON.parse(readFileSync("public/trajectory-library/tasks/webarena-153.json", "utf8"));
    const traceA = task.traces.find((trace: { modelId: string }) => trace.modelId.includes("gpt3.5")) ?? task.traces[0];
    const traceB = task.traces.find((trace: { modelId: string }) => trace.modelId.includes("gpt4")) ?? task.traces[1];
    const analysis = analyzeGuiAgentTraces(task, traceA, traceB);

    expect(analysis.rejoinStep).toBe(6);
    expect(analysis.persistentDivergence).toBe(false);
    expect(analysis.comparisons.find((comparison) => comparison.stepIndex === 6)?.event).toBe("rejoined");
  });
});
