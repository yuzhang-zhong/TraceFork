import { parsePastedTrajectory } from "../../src/traceWorkbench.js";
import type { GuiAgentTask } from "../../src/projectTypes.js";
import type { ApiRequest, ApiResponse } from "../_supabase.js";
import { handleCorsPreflight, setJsonHeaders } from "../_supabase.js";

type Provider = "openai" | "gemini" | "local";

type InlineImage = {
  ref: string;
  mimeType: string;
  base64?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStreamBody(req: ApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    if (!req.on) {
      resolve(Buffer.alloc(0));
      return;
    }
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""))));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

async function payload(req: ApiRequest): Promise<Record<string, unknown>> {
  if (isRecord(req.body)) return req.body;
  const raw = await readStreamBody(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function fallbackTask(value: unknown): GuiAgentTask {
  const task = isRecord(value) ? value : {};
  return {
    taskId: typeof task.taskId === "string" ? task.taskId : "pasted-task",
    title: typeof task.title === "string" ? task.title : "Pasted trajectory task",
    instruction: typeof task.instruction === "string" ? task.instruction : "Inspect pasted trajectory actions.",
    domain: typeof task.domain === "string" ? task.domain : "Pasted trajectory",
    startUrl: typeof task.startUrl === "string" ? task.startUrl : "offline://pasted-trajectory",
    successCriteria: typeof task.successCriteria === "string" ? task.successCriteria : "Compare observable actions and states.",
    riskTags: ["pasted", "llm-parser"],
    textState: "Pasted observable actions are available.",
    visualState: "Screenshots may be absent unless supplied in normalized JSON.",
    screenshotSize: isRecord(task.screenshotSize)
      ? {
          width: typeof task.screenshotSize.width === "number" ? task.screenshotSize.width : 1280,
          height: typeof task.screenshotSize.height === "number" ? task.screenshotSize.height : 820,
        }
      : { width: 1280, height: 820 },
    traces: [],
    sourceType: "normalized_json",
    sourceLabel: "Pasted trajectory",
  };
}

function extractInlineImages(value: string): InlineImage[] {
  const images: InlineImage[] = [];
  const seen = new Set<string>();
  const dataPattern = /data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=]+)/gi;
  for (const match of value.matchAll(dataPattern)) {
    const mimeType = `image/${match[1].toLowerCase()}`;
    const ref = `data:${mimeType};base64,${match[2]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      images.push({ ref, mimeType, base64: match[2] });
    }
  }
  const urlPattern = /\b(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?)\b/gi;
  for (const match of value.matchAll(urlPattern)) {
    const ref = match[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      images.push({ ref, mimeType: "image/*" });
    }
  }
  return images.slice(0, 8);
}

function redactImagePayloads(value: string): string {
  let index = 0;
  return value.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, () => {
    index += 1;
    return `[attached image ${index}]`;
  });
}

function parserPrompt(rawText: string, modelName: string, task: GuiAgentTask): string {
  const imageRefs = extractInlineImages(rawText).map((image, index) => `frame_${index + 1}: ${image.ref.startsWith("data:image/") ? `[attached image ${index + 1}]` : image.ref}`);
  return [
    "Convert the pasted GUI/web-agent trajectory into STRICT JSON only. The JSON must be directly importable by TraceFork.",
    "Do not infer or expose private chain-of-thought. Extract observable browser actions, targets, URLs, observations, and states only.",
    "Use public model output excerpts only when they are present in the pasted log; do not summarize hidden reasoning.",
    "If screenshots or frames are supplied, assign each image to the closest step and copy the exact frame ref into both screenshotRef and thumbnailRef.",
    "If there are multiple runs, return a task bundle with traces. If there is one run, return a single trace object.",
    "Return one of these shapes:",
    JSON.stringify({
      taskId: task.taskId,
      title: task.title,
      instruction: task.instruction,
      traces: [
        {
          traceId: "string",
          agentId: "string",
          modelId: modelName,
          actorType: "human|model|unknown",
          observationMode: "text|vision|mixed|unknown",
          outcome: "success|failed|unknown",
          steps: [
            {
              stepIndex: 1,
              observationType: "dom|screenshot|mixed",
              observationSummary: "observable state summary",
              actionType: "click|type|scroll|select|wait|navigate",
              target: { label: "observable target", domSelector: "optional selector", bbox: [0, 0, 80, 32] },
              inputText: "optional typed text",
              confidence: 0.5,
              stateAfter: "observable state after action",
              url: "optional URL",
              screenshotRef: "optional exact image/frame ref",
              thumbnailRef: "optional exact image/frame ref",
              agentOutputExcerpt: "optional public model output excerpt",
            },
          ],
        },
      ],
    }),
    "or:",
    JSON.stringify({
      traceId: "string",
      agentId: "string",
      modelId: modelName,
      steps: [
        {
          stepIndex: 1,
          observationType: "dom|screenshot|mixed",
          observationSummary: "observable state summary",
          actionType: "click|type|scroll|select|wait|navigate",
          target: { label: "observable target", domSelector: "optional selector", bbox: [0, 0, 80, 32] },
          inputText: "optional typed text",
          confidence: 0.5,
          stateAfter: "observable state after action",
          url: "optional URL",
          screenshotRef: "optional exact image/frame ref",
          thumbnailRef: "optional exact image/frame ref",
          agentOutputExcerpt: "optional public model output excerpt",
        },
      ],
    }),
    imageRefs.length ? `Available image refs:\n${imageRefs.join("\n")}` : "Available image refs: none",
    `Task: ${task.title}`,
    `Instruction: ${task.instruction}`,
    "Pasted trajectory:",
    redactImagePayloads(rawText).slice(0, 24000),
  ].join("\n");
}

async function callOpenAI(apiKey: string, prompt: string, images: InlineImage[]): Promise<string> {
  const content = [
    { type: "input_text", text: prompt },
    ...images.map((image) => ({ type: "input_image", image_url: image.ref })),
  ];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI parser failed: ${response.status}`);
  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.output_text === "string") return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  const text = output
    .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("");
  return text;
}

async function callGemini(apiKey: string, prompt: string, images: InlineImage[]): Promise<string> {
  const parts = [
    { text: prompt },
    ...images
      .filter((image) => Boolean(image.base64))
      .map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.base64,
        },
      })),
  ];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!response.ok) throw new Error(`Gemini parser failed: ${response.status}`);
  const json = (await response.json()) as Record<string, unknown>;
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = candidates[0];
  const parts = isRecord(first) && isRecord(first.content) && Array.isArray(first.content.parts) ? first.content.parts : [];
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (handleCorsPreflight(req, res)) return;
  setJsonHeaders(res);
  if (req.method && req.method !== "POST") {
    res.status(405).json({ ok: false, errors: ["Use POST /api/trajectory/parse-paste"], warnings: [] });
    return;
  }

  try {
    const body = await payload(req);
    const rawText = typeof body.rawText === "string" ? body.rawText : "";
    const provider: Provider = body.provider === "openai" || body.provider === "gemini" ? body.provider : "local";
    const userApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const modelName = typeof body.modelName === "string" && body.modelName.trim() ? body.modelName.trim() : "pasted-run";
    const task = fallbackTask(body.task);

    if (!rawText.trim()) {
      res.status(400).json({ ok: false, errors: ["rawText is required"], warnings: [] });
      return;
    }

    if (provider === "local") {
      const parsed = parsePastedTrajectory(rawText, task, modelName);
      res.status(parsed.ok ? 200 : 400).json(parsed);
      return;
    }

    const envApiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
    const apiKey = userApiKey || envApiKey || "";
    if (!apiKey.trim()) {
      res.status(400).json({
        ok: false,
        errors: [`${provider} parser requires a temporary API key or server-side ${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"}.`],
        warnings: [],
      });
      return;
    }

    const images = extractInlineImages(rawText);
    const prompt = parserPrompt(rawText, modelName, task);
    const modelText = provider === "openai" ? await callOpenAI(apiKey, prompt, images) : await callGemini(apiKey, prompt, images);
    const parsed = parsePastedTrajectory(modelText, task, modelName);
    res.status(parsed.ok ? 200 : 400).json(parsed);
  } catch (error) {
    const task = fallbackTask({});
    const raw = isRecord(req.body) && typeof req.body.rawText === "string" ? req.body.rawText : "";
    const local = raw ? parsePastedTrajectory(raw, task, "pasted-run") : null;
    if (local?.ok) {
      res.status(200).json({ ...local, warnings: [...local.warnings, "LLM parser failed; local parser fallback used."] });
      return;
    }
    res.status(500).json({
      ok: false,
      errors: [error instanceof Error ? error.message : "Paste parser failed"],
      warnings: [],
    });
  }
}
