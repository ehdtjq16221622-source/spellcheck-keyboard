-- 2026-10-30: the one-time batch merged 2,189 legacy Apple-subject wallets, but it also
-- protected wallets that older clients still used without a wallet session, which would
-- have shown "update the app" on AI requests. Before any client traffic hit those wallets,
-- 2,155 merges whose canonical wallet had no live session and no AI use in 90 days were
-- restored exactly (balances, aliases, new protection rows, merge records). 34 merges for
-- users already on their canonical wallet were kept. The remaining wallets merge through
-- the normal in-app "지갑 연결" flow under the relaxed policy in 20261030090000.
drop function if exists public.admin_batch_merge_linked_apple_subjects(integer, boolean);
