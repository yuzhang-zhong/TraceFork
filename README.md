<p align="center">
  <img src="public/tracefork-icon.svg" alt="TraceFork icon" width="96" height="96" />
</p>

# TraceFork

TraceFork is a research prototype for inspecting and comparing same-task GUI-agent trajectories. It turns released or user-provided web-agent traces into a normalized step schema, aligns two runs, and renders an inspection tree that shows shared progress, forks, missing counterparts, and later convergence.

The project is designed for trajectory inspection rather than live agent control. It supports comparisons such as human-vs-model, model-vs-model, prompt-setting variants, and successful-vs-failed runs when the runs belong to the same task.

## What It Does

- Searches a static trajectory library built from WebArena / VisualWebArena-style traces.
- Compares two same-task runs with deterministic alignment and divergence scoring.
- Renders an inspection tree with action nodes, fork/rejoin structure, and screenshot hover evidence.
- Supports pasted raw logs, render HTML excerpts, normalized JSON, and optional image-frame attachments.
- Includes dataset import, static library export, and diagnostic retrieval scripts.

TraceFork only uses observable trace artifacts: actions, targets, page/state summaries, screenshots, URLs after local-origin redaction, and public model output excerpts when present in released logs. It does not claim access to private chain-of-thought.

## Quick Start

```bash
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

```text
public/trajectory-library/
```

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

```text
supabase/schema.sql
```

and configure server-side environment variables:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Do not expose service-role keys in browser code.

## Deployment

The included GitHub Pages workflow builds the Vite app with:

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

## License

The TraceFork source code is released under the MIT License. See
[LICENSE](LICENSE) for details.

Benchmark-derived trajectories, screenshots, thumbnails, logs, and other
third-party artifacts are not covered by the MIT License. They remain subject
to the licenses and terms of their original sources, including WebArena and
VisualWebArena. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
