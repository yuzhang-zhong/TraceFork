<div align="center">

  <img src="public/tracefork-icon.svg" alt="TraceFork icon" width="96" height="96" />

# TraceFork

**English** · [简体中文](README.zh-CN.md)

**A System for Inspecting GUI-Agent Trajectory Forks**

[![React](https://img.shields.io/badge/React-19-149eca)](package.json)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6)](src/)
[![License](https://img.shields.io/badge/Code_license-MIT-green)](LICENSE)

**Accepted to EMNLP 2026 System Demonstrations.**  
Yuzhang Zhong and Stephen Xia · [Publication details](https://yuzhang-zhong.github.io/publication/2026-tracefork)

[Live demo](https://yuzhang-zhong.github.io/TraceFork/) · [Quick start](#quick-start) · [Features](#what-it-does) · [Trajectory library](#static-trajectory-library) · [Deployment](#deployment) · [Contributing](#contributing)

</div>

TraceFork helps researchers and agent engineers compare GUI-agent, browser-agent, and computer-use runs of the same task to inspect where their execution trajectories diverge. It normalizes released or user-provided web-agent execution traces, computes a deterministic trajectory diff and step alignment, and renders an interactive inspection tree that highlights shared progress, branching forks, unmatched actions, and later convergence.

Built for trajectory inspection rather than live agent control, TraceFork supports human–model and model–model comparisons, prompt-setting variants, and successful-versus-failed runs of the same task.

## What It Does

- Searches a static trajectory library built from WebArena / VisualWebArena-style traces.
- Compares two same-task runs with deterministic alignment and divergence scoring.
- Renders an inspection tree with action nodes, fork/rejoin structure, and screenshot hover evidence.
- Supports pasted raw logs, render HTML excerpts, normalized JSON, and optional image-frame attachments.
- Includes dataset import, static library export, and diagnostic retrieval scripts.

TraceFork only uses observable trace artifacts: actions, targets, page/state summaries, screenshots, URLs after local-origin redaction, and public model output excerpts when present in released logs. It does not claim access to private chain-of-thought.

## Quick Start

With Node.js and npm installed:

```bash
git clone https://github.com/yuzhang-zhong/TraceFork.git
cd TraceFork
npm install
npm run dev
```

Then open the local Vite URL printed by the terminal.

To build:

```bash
npm run build
```

To run tests:

```bash
npm test
```

## Static Trajectory Library

The repository includes a static, normalized trajectory library under:

[`public/trajectory-library/`](public/trajectory-library/).

Raw benchmark archives are intentionally not committed. If you have local WebArena / VisualWebArena releases, keep them outside the frontend bundle and use:

```bash
npm run dataset:audit
npm run dataset:export-static
npm run dataset:diagnostics
npm run dataset:research-cases
```

`Datasets/`, `dist/`, `node_modules/`, local logs, credentials, and generated process screenshots are ignored by git.

## Optional Supabase Backend

TraceFork can run as a static demo from the bundled trajectory library. For a hosted searchable database, apply:

[`supabase/schema.sql`](supabase/schema.sql)

and configure server-side environment variables:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Do not expose service-role keys in browser code.

## Deployment

The included [GitHub Pages workflow](.github/workflows/pages.yml) builds the Vite app with:

```text
VITE_BASE_PATH=/TraceFork/
```

For backend API routes such as hosted parsing or Supabase-backed search, deploy the API separately on a serverless host and set `VITE_API_BASE_URL` at build time.

## Repository Hygiene

This public repository should not contain:

- `.env*` files or API keys
- raw WebArena / VisualWebArena archives
- local Playwright trace zips
- private drafts, review files, or generated manuscript figures
- generated `dist/` output
- local screenshots, temporary logs, or machine-specific paths

## Contributing

Contributions are welcome. To propose a change:

1. Fork the repository and create a branch for your change.
2. Install dependencies with `npm install`, and verify with `npm test` and `npm run build`.
3. Open a pull request describing the change and the trajectory fixtures it affects, if any.

Please do not commit secrets, benchmark archives, or generated `dist/` output (see [Repository Hygiene](#repository-hygiene)).

## 中文简介

TraceFork（EMNLP 2026 System Demonstrations）是一套用于**比较同一任务下 GUI 智能体、网页浏览器智能体（Web Agent / Computer-Use Agent）多次执行轨迹分叉与汇合**的交互式检查系统（[在线体验](https://yuzhang-zhong.github.io/TraceFork/)）。系统将 WebArena / VisualWebArena 或自定义日志规范化后进行确定性步骤对齐与轨迹差异（Trajectory Diff）评分，以分叉检查树直观展示共同步骤、行为分歧点、未匹配动作及悬停截图证据，支持人机对比、不同模型或提示词对比，以及成功与失败轨迹的故障诊断。详见[简体中文说明](README.zh-CN.md)。

## License

The TraceFork source code is released under the MIT License. See
[LICENSE](LICENSE) for details.

Benchmark-derived trajectories, screenshots, thumbnails, logs, and other
third-party artifacts are not covered by the MIT License. They remain subject
to the licenses and terms of their original sources, including WebArena and
VisualWebArena. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
