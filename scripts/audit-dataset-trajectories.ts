import fs from "node:fs/promises";
import path from "node:path";
import { importDatasetTrajectories } from "./dataset-trajectories";

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const rootDir = path.resolve(argValue("--root", positional) ?? "Datasets");
  const maxTasks = Number(argValue("--max-tasks-per-collection", "") || 0) || undefined;
  const collectionFilter = argValue("--collection");
  const progress = hasFlag("--progress") && !hasFlag("--quiet");
  const { audit } = await importDatasetTrajectories({
    rootDir,
    writeThumbnails: false,
    thumbnailLimitPerRun: 2,
    maxTasksPerCollection: maxTasks,
    collectionFilter,
    progress,
  });
  await fs.mkdir(path.resolve("artifacts"), { recursive: true });
  await fs.writeFile(path.resolve("artifacts", "dataset-trajectory-audit.json"), JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(audit, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
