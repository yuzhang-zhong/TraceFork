const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");

function runStep(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function killProcessTree(processHandle) {
  if (!processHandle?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(processHandle.pid), "/T", "/F"], {
      cwd: root,
      shell: false,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    processHandle.kill("SIGTERM");
  }
}

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until preview is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function verifyBrowserFlow() {
  const preview = spawn("npm", ["run", "preview", "--", "--port", "4177"], {
    cwd: root,
    shell: process.platform === "win32",
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  let browser;

  try {
    await waitForServer("http://127.0.0.1:4177/");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.goto("http://127.0.0.1:4177/", { waitUntil: "networkidle" });
    if ((await page.locator(".tracefork-shell").count()) !== 1) {
      throw new Error("TraceFork shell did not render");
    }
    if ((await page.locator(".side-tab").count()) !== 3) {
      throw new Error("Right rail should expose Search, Paste, and Cases tabs");
    }
    if ((await page.locator(".side-tab.active").innerText()) !== "Search") {
      throw new Error("Search tab should be active by default");
    }
    if ((await page.locator(".tool-section").count()) !== 1) {
      throw new Error("Right rail should render one active tab panel at a time");
    }
    await page.getByRole("button", { name: "Guide" }).click();
    if ((await page.locator(".guide-popover").count()) !== 1) {
      throw new Error("Mini guide popover should open from the topbar question button");
    }
    const guideText = await page.locator(".guide-popover").innerText();
    if (!/percentages|divergence score|paths/i.test(guideText)) {
      throw new Error("Mini guide should explain percentages and path geometry");
    }
    await page.getByRole("button", { name: "Close" }).click();
    if ((await page.locator(".guide-popover").count()) !== 0) {
      throw new Error("Mini guide popover should close");
    }
    if ((await page.locator(".embedding-dot").count()) < 40) {
      throw new Error("AgentDiagnose-style embedding selector should render semantic points");
    }
    if ((await page.locator(".embedding-dot.active").count()) !== 1) {
      throw new Error("Semantic embedding selector should highlight exactly one selected task point");
    }
    if ((await page.locator(".action-chip").count()) < 10) {
      throw new Error("AgentDiagnose-style action selector should render action chips");
    }
    await page.getByRole("button", { name: "Cases" }).click();
    if ((await page.locator(".side-tab.active").innerText()) !== "Cases") {
      throw new Error("Cases tab should become active");
    }
    if ((await page.locator(".research-case").count()) !== 10) {
      throw new Error("Research case library should expose 10 curated real trajectory comparisons");
    }
    const researchCasesResponse = await page.request.get("http://127.0.0.1:4177/trajectory-library/research-cases.json");
    if (!researchCasesResponse.ok()) {
      throw new Error("Research case library JSON should be fetchable");
    }
    const researchCasesJson = await researchCasesResponse.json();
    const researchCases = Array.isArray(researchCasesJson.cases) ? researchCasesJson.cases : [];
    if (researchCases.length !== 10) {
      throw new Error("Research case JSON should contain exactly 10 cases");
    }
    const lowQualityCase = researchCases.find((row) => {
      const missing = Number(row?.metrics?.missingRate ?? 1);
      const steps = Number(row?.metrics?.stepPairs ?? 0);
      const text = `${row?.label ?? ""} ${row?.kind ?? ""} ${row?.runALabel ?? ""} ${row?.runBLabel ?? ""}`;
      return missing > 0.25 || steps < 4 || /\bfailed\b|failure contrast|early stop|unable to|could not|cannot|not found|same action/i.test(text);
    });
    if (lowQualityCase) {
      throw new Error(`Research case library contains low-value or failure-like case: ${lowQualityCase.taskId ?? "unknown"}`);
    }
    const researchCaseText = await page.locator(".research-case").evaluateAll((nodes) =>
      nodes.map((node) => node.textContent || "").join("\n"),
    );
    if (/\bfailed\b|failure contrast/i.test(researchCaseText)) {
      throw new Error("Research case library should not expose explicit failure-based cases");
    }
    await page.getByRole("button", { name: "Search" }).click();
    if ((await page.locator(".term-mode-toggle").count()) !== 0) {
      throw new Error("Action selector should not expose redundant verb/noun mode toggles");
    }
    if ((await page.locator(".semantic-region").count()) < 4) {
      throw new Error("Semantic selector should render lightweight region hints");
    }
    if ((await page.locator(".embedding-label").count()) !== 0) {
      throw new Error("Selected task label should not be rendered inside the semantic map");
    }
    if ((await page.locator(".semantic-selected-summary").count()) !== 1) {
      throw new Error("Selected task summary should render outside the semantic map");
    }
    await page.locator(".embedding-dot").first().hover();
    await page.waitForFunction(() => {
      const preview = document.querySelector(".semantic-hover-preview");
      return preview && Number.parseFloat(window.getComputedStyle(preview).opacity || "0") > 0.9;
    });
    const previewOpacity = await page.locator(".semantic-hover-preview").evaluate((node) => {
      return Number.parseFloat(window.getComputedStyle(node).opacity || "0");
    });
    if (previewOpacity < 0.9) {
      throw new Error("Embedding point hover should reveal a floating task preview");
    }
    const resultCountBeforeChip = await page.locator(".task-result").count();
    await page.locator(".action-chip").first().click();
    const resultCountAfterChip = await page.locator(".task-result").count();
    if (resultCountAfterChip !== resultCountBeforeChip) {
      throw new Error("Action chip selection should not immediately reorder or refresh task results");
    }
    await page.waitForFunction(() => document.querySelectorAll(".path-card").length >= 5, null, { timeout: 6000 });
    if ((await page.locator(".canvas-empty-state").count()) !== 0) {
      throw new Error("Canvas should auto-generate the initially selected comparable task");
    }
    await page.getByRole("button", { name: "Cases" }).click();
    await page.locator(".research-case").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".path-card").length >= 5, null, { timeout: 6000 });
    await page.waitForFunction(() => document.querySelectorAll(".research-case.active").length === 1, null, { timeout: 6000 });
    if ((await page.locator(".research-case.active").count()) !== 1) {
      throw new Error("Selecting a research case should mark exactly one case active");
    }
    if ((await page.locator(".path-node circle").count()) !== 0) {
      throw new Error("Circle nodes should not be present in the split-path redesign");
    }

    await page.getByRole("button", { name: /重新生成|Regenerate/ }).click();
    if ((await page.locator(".path-card").count()) < 5) {
      throw new Error("Generated comparison should render textbox path cards");
    }
    if ((await page.locator(".path-line").count()) < 4) {
      throw new Error("Generated comparison should render straight path lines");
    }
    const canvasBounds = await page.evaluate(() => {
      const board = document.querySelector(".path-board");
      const stage = document.querySelector(".split-path-stage");
      const legend = document.querySelector(".arrow-legend");
      const task = document.querySelector(".path-card.lane-task");
      const cards = [...document.querySelectorAll(".path-card")];
      if (!board || !stage) return { missing: true };
      const boardRect = board.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const outCards = cards.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < stageRect.left || rect.right > stageRect.right || rect.top < stageRect.top || rect.bottom > stageRect.bottom;
      }).length;
      const clippedVisibleCards = cards.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < boardRect.left || rect.right > boardRect.right;
      }).length;
      const legendRect = legend?.getBoundingClientRect();
      const taskRect = task?.getBoundingClientRect();
      const legendTaskOverlap =
        Boolean(legendRect && taskRect) &&
        !(legendRect.right < taskRect.left || legendRect.left > taskRect.right || legendRect.bottom < taskRect.top || legendRect.top > taskRect.bottom);
      return { missing: false, outCards, clippedVisibleCards, legendTaskOverlap };
    });
    if (canvasBounds.missing || canvasBounds.outCards || canvasBounds.clippedVisibleCards || canvasBounds.legendTaskOverlap) {
      throw new Error(`Canvas layout should not clip cards or overlap legend/task: ${JSON.stringify(canvasBounds)}`);
    }
    const imageCardIndexes = await page.locator(".path-card").evaluateAll((nodes) =>
      nodes.map((node, index) => ({ index, hasImage: Boolean(node.querySelector("img")) })).filter((node) => node.hasImage),
    );
    if (imageCardIndexes.length < 3) {
      throw new Error("Generated comparison should expose screenshot-backed path steps");
    }
    let previewText = "";
    let previewImageReady = false;
    for (const imageCard of imageCardIndexes) {
      await page.locator(".path-card").nth(imageCard.index).hover();
      await page.waitForSelector(".node-popover.floating-preview", { state: "visible" });
      previewText = await page.locator(".node-popover.floating-preview").innerText();
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll(".node-popover.floating-preview img")].some(
              (image) => image.complete && image.naturalWidth > 0,
            ),
          null,
          { timeout: 1500 },
        )
        .catch(() => undefined);
      previewImageReady = await page.locator(".node-popover.floating-preview img").evaluateAll((images) =>
        images.some((image) => image.complete && image.naturalWidth > 0),
      );
      if (previewImageReady) break;
    }
    if (!/agent output/i.test(previewText)) {
      throw new Error("Hover preview should expose observable agent output");
    }
    if (/\bURL\b|localhost|127\.0\.0\.1|0\.0\.0\.0|[A-Z]:\\/i.test(previewText)) {
      throw new Error("Hover preview should not expose raw URL or local path traces");
    }
    if (!previewImageReady) {
      throw new Error("Hover preview should load trajectory screenshot thumbnails");
    }

    await page.getByRole("button", { name: "Paste" }).click();
    if ((await page.locator("textarea").count()) !== 1) {
      throw new Error("Paste tab should expose the trajectory textarea");
    }
    await page.locator("textarea").fill("1. click [Notifications] at https://demo.local/settings\n2. click [Promotional emails toggle]\n3. click [Save changes]");
    await page.getByRole("button", { name: /本地解析|Parse locally/ }).click();
    await page
      .waitForFunction(
        () => [...document.querySelectorAll("select option")].some((option) => /pasted-run/i.test(option.textContent || "")),
        null,
        { timeout: 5000 },
      )
      .catch(() => undefined);
    const pastedRunOptionCount = await page.locator("select option").evaluateAll((options) =>
      options.filter((option) => /pasted-run/i.test(option.textContent || "")).length,
    );
    if (pastedRunOptionCount < 1) {
      throw new Error("Pasted trajectory should be parsed and added");
    }
    await page.getByRole("button", { name: /生成对比|Generate comparison|重新生成|Regenerate/ }).click();
    if ((await page.locator(".path-card").count()) < 5) {
      throw new Error("Pasted trajectory comparison should render text cards");
    }

    await page.getByRole("button", { name: "Search" }).click();
    await page.getByPlaceholder(/关键词|Keyword/).fill("checkout");
    await page.locator(".search-row button").click();
    await page.waitForTimeout(200);
    if ((await page.locator(".task-result").count()) < 1) {
      throw new Error("Task library search should show local or remote results");
    }

    await page.setViewportSize({ width: 390, height: 880 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) {
      throw new Error("Mobile layout has horizontal overflow");
    }

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    killProcessTree(preview);
  }
}

(async () => {
  runStep("npm", ["test"]);
  runStep("npx", ["vitest", "run", "scripts/__tests__/dataset-trajectories.test.ts"]);
  runStep("npm", ["run", "dataset:audit"]);
  runStep("npm", ["run", "audit:gui-traces"]);
  runStep("npm", ["run", "audit:gui-evaluation"]);
  runStep("npm", ["run", "audit:trajectory-evaluation"]);
  runStep("npm", ["run", "audit:trajectory-random-samples"]);
  runStep("npm", ["run", "audit:trajectory-ui-samples"]);
  runStep("npm", ["run", "build"]);
  await verifyBrowserFlow();
  console.log("Verification passed: split-path TraceFork canvas, three right-rail tabs, paste parser, textbox nodes, straight arrows, task search fallback, and mobile layout.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
