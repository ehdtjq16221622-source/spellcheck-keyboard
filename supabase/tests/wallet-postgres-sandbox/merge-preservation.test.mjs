import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL(
  '../../migrations/20261007045625_preserve_wallet_merge_balances.sql', import.meta.url), 'utf8');

async function database(sourceFree, destinationFree, ledger) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table device_credits(device_id text primary key, apple_user_id text unique,
      free_credits int, paid_credits int default 0, subscription_credits int default 0,
      updated_at timestamptz default now());
    create table credit_wallet_sessions(token_hash text primary key, wallet_id text, apple_sub text,
      expires_at timestamptz, revoked_at timestamptz);
    create table credit_transactions(id uuid default gen_random_uuid(), device_id text,
      transaction_type text, idempotency_key text, free_delta int default 0, paid_delta int default 0,
      metadata jsonb default '{}', created_at timestamptz default now());
    create table device_subscriptions(device_id text primary key, product_id text,
      purchase_token text, updated_at timestamptz);
    create table credit_wallet_aliases(source_wallet_id text primary key,canonical_wallet_id text,apple_sub text);
    create table credit_protected_wallets(wallet_id text primary key);
    create table credit_wallet_merge_operations(apple_sub text primary key, request_id text,
      source_wallet_id text,canonical_wallet_id text,source_before jsonb,destination_before jsonb,
      free_after int,paid_after int);
    create table credit_legacy_merge_operations(source_wallet_id text primary key,apple_sub text,
      request_id text,canonical_wallet_id text,source_before jsonb,destination_before jsonb,
      free_after int,paid_after int);
    insert into credit_wallet_sessions values(repeat('a',64),'destination','source',now()+interval '1 day',null);
    insert into credit_protected_wallets values('destination');
  `);
  try { await db.exec(migration); } catch(error) { await db.close(); throw error; }
  await db.query("insert into device_credits(device_id,apple_user_id,free_credits,paid_credits) values('source',null,$1,10),('destination','source',$2,20)",
    [sourceFree,destinationFree]);
  for (const [wallet,type,delta,age='1 hour',refunded=false] of ledger) {
    await db.query("insert into credit_transactions(device_id,transaction_type,free_delta,created_at,metadata) values($1,$2,$3,now()-$4::interval,$5::jsonb)",
      [wallet,type,delta,age,JSON.stringify({refunded})]);
  }
  return db;
}
async function merge(db, route) {
  return route === 'linked'
    ? db.query('select * from merge_linked_apple_subject_wallets_once($1,$2,$3)', ['source','request','a'.repeat(64)])
    : db.query('select * from merge_verified_legacy_wallet_v2_once($1,$2,$3,$4)', ['source','source','a'.repeat(64),'request']);
}
const cases = [
  { name:'earned 100 survives', source:100,destination:490,
    ledger:[['source','ad_reward',100],['destination','server_ai_usage',-10]],expected:590 },
  { name:'duplicate installation bonus only is removed',source:500,destination:500,
    ledger:[['source','install_bonus',500],['destination','install_bonus',500]],expected:500 },
  { name:'bonus plus earned reward preserves reward',source:600,destination:490,
    ledger:[['source','install_bonus',500],['source','referral_invitee_reward',100],
      ['destination','install_bonus',500],['destination','server_ai_usage',-10]],expected:590 },
  { name:'earned balance after use is preserved',source:80,destination:490,
    ledger:[['source','ad_reward',100],['source','server_ai_usage',-20]],expected:570 },
  { name:'unexplained historical 500 is held',source:500,destination:500,ledger:[],error:/provenance/ },
  { name:'mixed bonus already spent is held',source:580,destination:500,
    ledger:[['source','install_bonus',500],['source','ad_reward',100],['source','server_ai_usage',-20]],error:/provenance/ },
  { name:'refund is held',source:50,destination:500,
    ledger:[['source','server_ai_refund',50]],error:/refund credits/ },
  { name:'recent source use is held',source:80,destination:500,
    ledger:[['source','ad_reward',100],['source','server_ai_usage',-20,'1 minute']],error:/Recent AI/ },
  { name:'recent destination use is held',source:100,destination:490,
    ledger:[['source','ad_reward',100],['destination','server_ai_usage',-10,'1 minute']],error:/Recent AI/ },
  { name:'overflow is held',source:100,destination:2147483647,
    ledger:[['source','ad_reward',100]],error:/overflow/ },
];
for (const route of ['linked','legacy']) for (const c of cases) {
  test(`${route}: ${c.name}`, async () => {
    const db = await database(c.source,c.destination,c.ledger);
    try {
      if(c.error) {
        await assert.rejects(merge(db,route),c.error);
        assert.deepEqual((await db.query('select free_credits from device_credits order by device_id')).rows,
          [{free_credits:c.destination},{free_credits:c.source}]);
        assert.equal((await db.query('select count(*)::int n from credit_wallet_aliases')).rows[0].n,0);
      } else {
        const result=await merge(db,route);
        assert.equal(result.rows[0].free_credits_remaining,c.expected);
        assert.equal(result.rows[0].paid_credits_remaining,30);
        await merge(db,route);
        assert.equal((await db.query("select free_credits from device_credits where device_id='destination'")).rows[0].free_credits,c.expected);
        assert.equal((await db.query('select count(*)::int n from credit_wallet_aliases')).rows[0].n,1);
      }
    } finally { await db.close(); }
  });
}

test('legacy fallback cannot bypass the linked refund gate',async()=>{
  const db=await database(50,500,[['source','server_ai_refund',50]]);
  try {
    await assert.rejects(merge(db,'linked'),/refund credits/);
    await assert.rejects(merge(db,'legacy'),/refund credits/);
  } finally {await db.close();}
});
