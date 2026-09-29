-- Read-only, bounded by the small device_subscriptions table. A grant row
-- proves a grant was recorded, not that its credits remain spendable.
with subscriptions as (
  select s.device_id, s.subscription_state, s.purchase_token, s.product_id,
    s.last_cycle_key,
    case
      when s.last_cycle_key like s.purchase_token || ':%' then s.last_cycle_key
      else s.purchase_token || ':' || s.product_id || ':' || s.last_cycle_key
    end as grant_key
  from public.device_subscriptions s
), grant_match as (
  select s.*, t.device_id as grant_wallet_id,
    a.canonical_wallet_id as grant_alias_target,
    c.subscription_credits as current_subscription_credits
  from subscriptions s
  left join public.credit_transactions t
    on t.transaction_type = 'subscription_monthly_grant'
    and t.idempotency_key = s.grant_key
  left join public.credit_wallet_aliases a on a.source_wallet_id = t.device_id
  left join public.device_credits c on c.device_id = s.device_id
)
select count(*) as subscriptions,
  count(*) filter (where subscription_state = 'SUBSCRIPTION_STATE_ACTIVE') as active,
  count(*) filter (where subscription_state = 'SUBSCRIPTION_STATE_ACTIVE'
    and grant_wallet_id is null) as active_without_grant_record,
  count(*) filter (where subscription_state = 'SUBSCRIPTION_STATE_ACTIVE'
    and grant_wallet_id is not null and grant_wallet_id <> device_id
    and grant_alias_target = device_id) as active_grant_on_aliased_wallet,
  count(*) filter (where subscription_state = 'SUBSCRIPTION_STATE_ACTIVE'
    and grant_wallet_id is not null and grant_wallet_id <> device_id
    and grant_alias_target is distinct from device_id) as active_grant_on_unlinked_wallet,
  count(*) filter (where subscription_state = 'SUBSCRIPTION_STATE_ACTIVE'
    and grant_wallet_id is not null and grant_wallet_id <> device_id
    and grant_alias_target is distinct from device_id
    and current_subscription_credits = 0) as active_unlinked_zero_balance
from grant_match;

-- A zero subscription balance alone is not a missing grant: the credits may
-- have been spent or the subscription may have expired. Plan changes must also
-- be checked against the wallet that received the current cycle grant.
with changed_plan_tokens as (
  select t.metadata->>'originalTransactionId' as purchase_token
  from public.credit_transactions t
  where t.transaction_type = 'subscription_monthly_grant'
    and t.created_at >= now() - interval '180 days'
  group by t.metadata->>'originalTransactionId'
  having count(distinct t.metadata->>'productId') > 1
), current_cycle as (
  select s.device_id, s.subscription_state,
    case when s.last_cycle_key like s.purchase_token || ':%'
      then s.last_cycle_key
      else s.purchase_token || ':' || s.product_id || ':' || s.last_cycle_key
    end as grant_key
  from public.device_subscriptions s
  join changed_plan_tokens p on p.purchase_token = s.purchase_token
)
select left(c.device_id, 8) as wallet_prefix, c.subscription_state,
  coalesce(w.subscription_credits, 0) as current_subscription_credits,
  left(t.device_id, 8) as grant_wallet_prefix,
  t.metadata->>'subscription_credits' as recorded_grant,
  case when t.device_id = c.device_id then 'same'
    when a.canonical_wallet_id = c.device_id then 'aliased'
    else 'unlinked' end as grant_route
from current_cycle c
left join public.device_credits w on w.device_id = c.device_id
left join public.credit_transactions t
  on t.transaction_type = 'subscription_monthly_grant'
  and t.idempotency_key = c.grant_key
left join public.credit_wallet_aliases a on a.source_wallet_id = t.device_id
order by current_subscription_credits, wallet_prefix
limit 20;
