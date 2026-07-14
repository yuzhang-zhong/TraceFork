create table if not exists public.tasks (
  task_id text primary key,
  title text not null,
  instruction text not null,
  domain text not null,
  start_url text,
  success_criteria text,
  risk_tags text[] default '{}',
  text_state text,
  visual_state text,
  screenshot_width integer default 1280,
  screenshot_height integer default 820,
  source_type text,
  source_label text,
  benchmark text,
  task_numeric_id text,
  site text,
  source_collection text,
  source_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trajectory_runs (
  trace_id text primary key,
  task_id text not null references public.tasks(task_id) on delete cascade,
  agent_id text not null,
  agent_kind text not null,
  model_id text not null,
  source_type text,
  source_label text,
  source_warnings text[] default '{}',
  benchmark text,
  site text,
  source_collection text,
  actor_type text,
  prompt_setting text,
  observation_mode text,
  outcome text,
  source_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trajectory_steps (
  trace_id text not null references public.trajectory_runs(trace_id) on delete cascade,
  step_index integer not null,
  observation_type text not null,
  observation_summary text not null,
  action_type text not null,
  target_label text not null,
  dom_selector text,
  bbox jsonb,
  input_text text,
  structured_rationale text,
  confidence double precision,
  state_after text not null,
  url text,
  screenshot_ref text,
  thumbnail_ref text,
  source_ref text,
  source_html_path text,
  visual_frame_available boolean default false,
  adapter_confidence text,
  source_warnings text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (trace_id, step_index)
);

create table if not exists public.source_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  task_id text references public.tasks(task_id) on delete cascade,
  trace_id text references public.trajectory_runs(trace_id) on delete cascade,
  source_type text not null,
  storage_path text,
  file_name text,
  mime_type text,
  byte_size bigint,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tasks_search_idx
  on public.tasks using gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(instruction, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(start_url, ''))
  );

create index if not exists trajectory_runs_task_idx on public.trajectory_runs(task_id);
create index if not exists trajectory_runs_model_idx on public.trajectory_runs(model_id);
create index if not exists trajectory_runs_source_idx on public.trajectory_runs(benchmark, site, source_collection, actor_type, outcome);
create index if not exists trajectory_steps_trace_idx on public.trajectory_steps(trace_id, step_index);
