import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { importDatasetTrajectories } from "../dataset-trajectories";

const datasetsRoot = path.resolve("Datasets");
const describeIfDatasets = fs.existsSync(datasetsRoot) ? describe : describe.skip;

describeIfDatasets("real dataset trajectory importer", () => {
  it("audits the seven local WebArena and VisualWebArena collections with a bounded sample", async () => {
    const { tasks, audit } = await importDatasetTrajectories({
      rootDir: datasetsRoot,
      maxTasksPerCollection: 1,
      writeThumbnails: false,
      thumbnailLimitPerRun: 1,
    });

    expect(audit.collectionCount).toBe(7);
    expect(audit.collections.map((collection) => collection.name)).toEqual(
      expect.arrayContaining([
        "visual_webarena_gpt4",
        "visual_webarena_human",
        "visual_webarena_human_3",
        "webarena_gpt35_16k_cot",
        "webarena_gpt4_8k_cot",
        "webarena_human_1",
        "webarena_human_2",
      ]),
    );
    expect(audit.runCount).toBeGreaterThan(0);
    expect(audit.stepCount).toBeGreaterThan(0);
    expect(tasks.some((task) => task.traces.length >= 2)).toBe(true);
  }, 60000);

  it("extracts visual frame references from official render HTML without using raw predictions", async () => {
    const { tasks } = await importDatasetTrajectories({
      rootDir: datasetsRoot,
      collectionFilter: "visual_webarena_gpt4",
      maxTasksPerCollection: 1,
      writeThumbnails: false,
      thumbnailLimitPerRun: 2,
    });
    const trace = tasks[0]?.traces[0];
    expect(trace).toBeTruthy();
    expect(trace?.observationMode).toBe("vision");
    expect(trace?.sourceWarnings?.join(" ")).toContain("raw prediction is not analyzed");
    expect(trace?.steps.some((step) => step.visualFrameAvailable && step.screenshotRef?.startsWith("embedded:"))).toBe(true);
  }, 30000);

  it("parses human Playwright zip actions as low-confidence observable steps", async () => {
    const { tasks } = await importDatasetTrajectories({
      rootDir: datasetsRoot,
      collectionFilter: "visual_webarena_human",
      maxTasksPerCollection: 1,
      writeThumbnails: false,
      thumbnailLimitPerRun: 1,
    });
    const trace = tasks[0]?.traces[0];
    expect(trace?.actorType).toBe("human");
    expect(trace?.sourceType).toBe("playwright_human_trace");
    expect(trace?.steps.length).toBeGreaterThan(0);
    expect(trace?.steps.some((step) => step.adapterConfidence === "low" || step.adapterConfidence === "medium")).toBe(true);
  }, 30000);

  it("aligns human Playwright visual frames to distinct screencast resources", async () => {
    const { tasks } = await importDatasetTrajectories({
      rootDir: datasetsRoot,
      collectionFilter: "visual_webarena_human_3",
      maxTasksPerCollection: 1,
      writeThumbnails: false,
      thumbnailLimitPerRun: 8,
    });
    const trace = tasks[0]?.traces[0];
    const frameRefs = trace?.steps.map((step) => step.screenshotRef).filter(Boolean) ?? [];
    expect(frameRefs.length).toBeGreaterThan(2);
    expect(new Set(frameRefs).size).toBeGreaterThan(2);
    expect(frameRefs.every((ref) => ref?.startsWith("zip:"))).toBe(true);
  }, 60000);
});
