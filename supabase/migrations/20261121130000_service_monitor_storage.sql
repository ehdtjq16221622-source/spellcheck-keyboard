-- Storage numbers for service_monitor's disk alarm (service role only).
create or replace function public.service_monitor_storage()
returns table(database_bytes bigint, http_response_bytes bigint)
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.pg_database_size(pg_catalog.current_database()),
         pg_catalog.pg_total_relation_size('net._http_response'::regclass);
$$;

revoke execute on function public.service_monitor_storage() from public, anon, authenticated;
grant execute on function public.service_monitor_storage() to service_role;
