import fs from "node:fs/promises";
import path from "node:path";
import { hasSupabaseConfig, upsertTasks } from "../api/_supabase";
import { importDatasetTrajectories } from "./dataset-trajectories";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const rootDir = path.resolve(argValue("--root", positional) ?? "Datasets");
  const dryRun = hasFlag("--dry-run") || !hasFlag("--supabase");
  const maxTasks = Number(argValue("--max-tasks-per-collection", "") || 0) || undefined;
  const thumbnailLimit = Number(argValue("--thumbnail-limit", "16")) || 16;
  const collectionFilter = argValue("--collection");
  const progress = hasFlag("--progress") && !hasFlag("--quiet");
  if (!dryRun && !hasSupabaseConfig()) {
    throw new Error(
      "dataset:import:supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY. Use npm run dataset:import for dry-run.",
    );
  }
  const { tasks, audit } = await importDatasetTrajectories({
    rootDir,
    writeThumbnails: !dryRun,
    thumbnailLimitPerRun: thumbnailLimit,
    maxTasksPerCollection: maxTasks,
    collectionFilter,
    progress,
  });
  const persistence = dryRun
    ? {
        persisted: false,
        reason: "dry-run; no Supabase write and no thumbnail files written",
        taskCount: tasks.length,
        runCount: audit.runCount,
        stepCount: audit.stepCount,
      }
    : await upsertTasks(tasks);
  const summary = {
    ...audit,
    dryRun,
    persistence,
    comparableExamples: tasks
      .filter((task) => task.traces.length >= 2)
      .slice(0, 12)
      .map((task) => ({
        taskId: task.taskId,
        title: task.title,
        runs: task.traces.map((trace) => ({
          traceId: trace.traceId,
          modelId: trace.modelId,
          actorType: trace.actorType,
          observationMode: trace.observationMode,
          outcome: trace.outcome,
          steps: trace.steps.length,
        })),
      })),
  };
  await fs.mkdir(path.resolve("artifacts"), { recursive: true });
  await fs.writeFile(path.resolve("artifacts", "dataset-trajectory-import.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
