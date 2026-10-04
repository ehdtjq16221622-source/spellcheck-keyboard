alter table public.telegram_alert_logs
  add column if not exists delivery_status text not null default 'unknown';

alter table public.telegram_alert_logs
  add constraint telegram_alert_logs_delivery_status_check
  check (delivery_status in ('unknown', 'delivered'));
