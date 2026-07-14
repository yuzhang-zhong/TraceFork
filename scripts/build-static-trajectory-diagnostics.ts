import fs from "node:fs/promises";
import path from "node:path";
import type { GuiAgentTask } from "../src/projectTypes";
import { diagnoseTask } from "../src/traceDiagnostics";

type StaticIndex = {
  generatedAt?: string;
  tasks?: Array<GuiAgentTask & { staticPath?: string }>;
};

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function main() {
  const libraryDir = path.resolve(argValue("--library", "public/trajectory-library"));
  const indexPath = path.join(libraryDir, "index.json");
  const outPath = path.join(libraryDir, "diagnostics.json");
  const index = await readJson<StaticIndex>(indexPath);
  const rows = [];

  for (const row of index.tasks ?? []) {
    if (!row.staticPath) continue;
    const taskPath = path.join(libraryDir, row.staticPath.replace(/^\/?trajectory-library[\\/]/, ""));
    const task = await readJson<GuiAgentTask>(taskPath);
    rows.push(diagnoseTask(task, row.staticPath));
  }

  const diagnostics = {
    schemaVersion: "tracefork-agentdiagnose-static-index-v1",
    generatedAt: new Date().toISOString(),
    sourceIndexGeneratedAt: index.generatedAt,
    method: [
      "Inspired by AgentDiagnose: trajectory retrieval is indexed by diagnostic dimensions rather than only keyword matching.",
      "Scores are deterministic heuristics over observable actions, states, observations, metadata, and screenshot availability.",
      "The index does not expose or evaluate private chain-of-thought.",
    ],
    dimensions: [
      "backtracking_exploration",
      "task_decomposition",
      "observation_reading",
      "self_verification",
      "objective_quality",
      "state_transition",
      "visual_evidence",
    ],
    rows,
  };

  const body = `${JSON.stringify(diagnostics)}\n`;
  await fs.writeFile(outPath, body, "utf8");
  console.log(JSON.stringify({ ok: true, outPath, rowCount: rows.length, bytes: Buffer.byteLength(body) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

