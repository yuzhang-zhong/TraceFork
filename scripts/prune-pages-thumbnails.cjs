const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const libraryDir = path.join(distDir, "trajectory-library");
const thumbnailDir = path.join(distDir, "trajectory-thumbnails");
const keepSearchTasks = Number(process.env.TRACEFORK_PAGES_KEEP_TASKS || "120") || 120;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectTaskRefs() {
  const taskPaths = collectKeepTaskPaths();
  const refs = new Set();
  for (const rel of taskPaths) {
    const taskPath = path.join(libraryDir, rel);
    if (!safeInside(libraryDir, taskPath) || !fs.existsSync(taskPath)) continue;
    const task = readJson(taskPath);
    for (const trace of task.traces || []) {
      for (const step of trace.steps || []) {
        for (const key of ["thumbnailRef", "screenshotRef"]) {
          const value = step[key];
          if (typeof value === "string" && value.startsWith("/trajectory-thumbnails/")) {
            refs.add(value.replace(/^\/trajectory-thumbnails\//, ""));
          }
        }
      }
    }
  }
  return refs;
}

function collectKeepTaskPaths() {
  const indexPath = path.join(libraryDir, "index.json");
  const casesPath = path.join(libraryDir, "research-cases.json");
  if (!fs.existsSync(indexPath)) return new Set();

  const index = readJson(indexPath);
  const cases = fs.existsSync(casesPath) ? readJson(casesPath).cases || [] : [];
  const taskPaths = new Set();

  for (const task of (index.tasks || []).slice(0, keepSearchTasks)) {
    if (task.staticPath) taskPaths.add(task.staticPath.replace(/^\/?trajectory-library[\\/]/, ""));
  }
  for (const caseRow of cases) {
    if (caseRow.staticPath) taskPaths.add(caseRow.staticPath.replace(/^\/?trajectory-library[\\/]/, ""));
  }

  return taskPaths;
}

function walkFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function main() {
  const keepTaskPaths = collectKeepTaskPaths();
  pruneTaskFiles(keepTaskPaths);

  const keep = collectTaskRefs();
  if (!keep.size) {
    console.log("No thumbnail pruning needed.");
    return;
  }

  let kept = 0;
  let removed = 0;
  let removedBytes = 0;
  for (const filePath of walkFiles(thumbnailDir)) {
    const rel = path.relative(thumbnailDir, filePath).replace(/\\/g, "/");
    if (keep.has(rel)) {
      kept += 1;
      continue;
    }
    const stat = fs.statSync(filePath);
    fs.rmSync(filePath, { force: true });
    removed += 1;
    removedBytes += stat.size;
  }

  console.log(
    `Pruned Pages thumbnails: kept ${kept}, removed ${removed}, removed ${(removedBytes / 1024 / 1024).toFixed(1)} MB.`,
  );
}

function pruneTaskFiles(keepTaskPaths) {
  const tasksDir = path.join(libraryDir, "tasks");
  if (!fs.existsSync(tasksDir) || !keepTaskPaths.size) return;

  let kept = 0;
  let removed = 0;
  let removedBytes = 0;
  for (const filePath of walkFiles(tasksDir)) {
    const rel = path.relative(libraryDir, filePath).replace(/\\/g, "/");
    if (keepTaskPaths.has(rel)) {
      kept += 1;
      continue;
    }
    const stat = fs.statSync(filePath);
    fs.rmSync(filePath, { force: true });
    removed += 1;
    removedBytes += stat.size;
  }

  console.log(
    `Pruned Pages task JSON: kept ${kept}, removed ${removed}, removed ${(removedBytes / 1024 / 1024).toFixed(1)} MB.`,
  );
}

main();
