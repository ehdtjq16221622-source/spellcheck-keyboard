-- Prepare only: apply before the AI deadline Edge Function rollout, never implicitly.
alter table public.ai_slow_requests
  add column if not exists request_id text,
  add column if not exists diagnostic_id uuid;

alter table public.ai_slow_requests drop constraint ai_slow_requests_kind_check;
alter table public.ai_slow_requests add constraint ai_slow_requests_kind_check
  check (kind in ('correct', 'translate'));

create index if not exists ai_slow_requests_request_id_idx
  on public.ai_slow_requests(request_id) where request_id is not null;
