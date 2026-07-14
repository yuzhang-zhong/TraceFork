import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type StepRecord = {
  thumbnailRef?: string;
  visualStateSignature?: string;
};

type TraceRecord = {
  steps?: StepRecord[];
};

type TaskRecord = {
  traces?: TraceRecord[];
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dHash(buffer: Buffer, region?: sharp.Region): Promise<string | undefined> {
  try {
    let image = sharp(buffer, { limitInputPixels: false });
    if (region) image = image.extract(region);
    const { data } = await image.resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
    let bits = "";
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  } catch {
    return undefined;
  }
}

async function visualStateSignature(filePath: string): Promise<string | undefined> {
  const buffer = await fs.readFile(filePath);
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const regions: Array<sharp.Region | undefined> = [undefined];
  if (width >= 32 && height >= 32) {
    regions.push(
      { left: 0, top: 0, width, height: Math.max(1, Math.floor(height * 0.62)) },
      {
        left: 0,
        top: Math.max(0, Math.floor(height * 0.18)),
        width,
        height: Math.max(1, Math.floor(height * 0.64)),
      },
    );
  }
  const hashes = (await Promise.all(regions.map((region) => dHash(buffer, region)))).filter((hash): hash is string => Boolean(hash));
  return hashes.length ? [...new Set(hashes)].join(";") : undefined;
}

async function main() {
  const root = process.argv[2] ?? "public/trajectory-library/tasks";
  const resolvedRoot = path.resolve(root);
  const files = (await fs.readdir(resolvedRoot)).filter((file) => file.endsWith(".json"));
  let updatedTasks = 0;
  let updatedSteps = 0;
  const cache = new Map<string, string | undefined>();

  for (const file of files) {
    const fullPath = path.join(resolvedRoot, file);
    const task = JSON.parse(await fs.readFile(fullPath, "utf8")) as TaskRecord;
    let changed = false;
    for (const trace of task.traces ?? []) {
      for (const step of trace.steps ?? []) {
        if (!step.thumbnailRef || step.visualStateSignature) continue;
        const imagePath = path.resolve("public", step.thumbnailRef.replace(/^\//, ""));
        if (!(await fileExists(imagePath))) continue;
        if (!cache.has(imagePath)) cache.set(imagePath, await visualStateSignature(imagePath));
        const signature = cache.get(imagePath);
        if (!signature) continue;
        step.visualStateSignature = signature;
        updatedSteps += 1;
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(fullPath, `${JSON.stringify(task)}\n`);
      updatedTasks += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        root: resolvedRoot,
        scannedTasks: files.length,
        updatedTasks,
        updatedSteps,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
