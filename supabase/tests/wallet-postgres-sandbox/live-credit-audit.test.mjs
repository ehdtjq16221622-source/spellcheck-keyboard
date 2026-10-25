import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const definitions=await readFile(new URL('./fixtures/20261025-live-ai-credit.sql',import.meta.url),'utf8')
const migration=await readFile(new URL('../../migrations/20261025091650_ai_refund_retry_ledger.sql',import.meta.url),'utf8')

test('production credit definitions in an isolated database',async t=>{
  const db=new PGlite()
  try {
    await db.exec(`
      create table device_credits(device_id text primary key,free_credits integer not null default 0,
        paid_credits integer not null default 0,subscription_credits integer not null default 0,
        last_reset_date date,updated_at timestamptz default now());
      create table credit_transactions(id uuid primary key default gen_random_uuid(),device_id text not null,
        transaction_type text not null,idempotency_key text not null,free_delta integer default 0,
        paid_delta integer default 0,metadata jsonb default '{}'::jsonb,
        created_at timestamptz default now(),unique(transaction_type,idempotency_key));
    `)
    await db.exec(definitions)
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema cron;
      create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';`)
    await db.exec(migration)
    const balance=async()=> (await db.query("select free_credits,subscription_credits,paid_credits from device_credits where device_id='wallet'")).rows[0]
    const consume=(kind='correct',id='request',wallet='wallet')=>db.query('select * from consume_ai_credits($1,$2,$3)',[wallet,id,kind])
    const refund=(id='request',wallet='wallet')=>db.query('select * from refund_ai_credits($1,$2)',[wallet,id])
    const fixture=async(values,run)=>{
      await db.exec('begin')
      try {
        await db.query('insert into device_credits(device_id,free_credits,subscription_credits,paid_credits) values ($1,$2,$3,$4)',['wallet',...values])
        await run()
      } finally {await db.exec('rollback')}
    }
    for(const [kind,cost] of [['correct',10],['formal',30],['translate',20]]) {
      for(const [label,values] of [['free',[100,0,0]],['subscription',[0,100,0]],['paid',[0,0,100]],['mixed',[3,4,100]]]) {
        await t.test(`${kind}: ${label} debit and repeated refund preserve exact buckets`,()=>fixture(values,async()=>{
          const before=await balance()
          assert.equal((await consume(kind)).rows[0].accepted,true)
          assert.equal(Object.values(await balance()).reduce((a,b)=>a+b,0),values.reduce((a,b)=>a+b,0)-cost)
          assert.equal((await consume(kind)).rows[0].already_processed,true)
          await refund();await refund()
          assert.deepEqual(await balance(),before)
          const r=(await db.query("select * from credit_transactions where transaction_type='server_ai_refund'")).rows
          assert.equal(r.length,1)
          assert.equal(r[0].free_delta+r[0].paid_delta+Number(r[0].metadata.subscription_credits),cost)
        }))
      }
    }
    await t.test('insufficient balance does not debit',()=>fixture([2,3,4],async()=>{
      assert.equal((await consume()).rows[0].accepted,false)
      assert.deepEqual(await balance(),{free_credits:2,subscription_credits:3,paid_credits:4})
    }))
    await t.test('request from another wallet cannot consume or refund the first wallet',()=>fixture([100,0,0],async()=>{
      await consume()
      await db.exec("insert into device_credits(device_id,free_credits) values ('other',100)")
      await db.exec('savepoint ownership')
      await assert.rejects(consume('correct','request','other'),/another device/)
      await db.exec('rollback to savepoint ownership')
      await assert.rejects(refund('request','other'),/not found/)
      await db.exec('rollback to savepoint ownership')
      assert.equal((await balance()).free_credits,90)
    }))
    await t.test('subscription cycle reset repeats only once and preserves paid/free',()=>fixture([100,50,300],async()=>{
      const reset=()=>db.query("select * from reset_subscription_credits('wallet',4000,'cycle','{}')")
      assert.equal((await reset()).rows[0].applied,true)
      await consume('formal')
      assert.equal((await reset()).rows[0].applied,false)
      assert.deepEqual(await balance(),{free_credits:70,subscription_credits:4000,paid_credits:300})
    }))
    await t.test('refund database failure rolls back all partial balance and ledger changes',()=>fixture([100,0,0],async()=>{
      await consume()
      await db.exec(`create function fail_refund() returns trigger language plpgsql as $$
        begin if new.transaction_type='server_ai_refund' then raise exception 'fixture write failure'; end if; return new; end $$;
        create trigger fail_refund before insert on credit_transactions for each row execute function fail_refund();
        savepoint refund_attempt;`)
      await assert.rejects(refund(),/fixture write failure/)
      await db.exec('rollback to savepoint refund_attempt')
      assert.equal((await balance()).free_credits,90)
      assert.equal((await db.query("select metadata->>'refunded' as refunded from credit_transactions where transaction_type='server_ai_usage'")).rows[0].refunded,'false')
      await db.exec('drop trigger fail_refund on credit_transactions')
      await refund()
      assert.equal((await balance()).free_credits,100)
    }))
    await t.test('reusing a refunded request twice must leave both refunds auditable',()=>fixture([100,0,0],async()=>{
      await consume();await refund()
      assert.equal((await consume()).rows[0].already_processed,false)
      await refund()
      assert.equal((await balance()).free_credits,100)
      const recorded=(await db.query("select sum(free_delta) as total from credit_transactions where transaction_type='server_ai_refund'")).rows[0].total
      assert.equal(Number(recorded),20,'two separate 10-credit refunds must not leave only one 10-credit refund in the ledger')
    }))
    const attempt=async(id='request',wallet='wallet')=>(await db.query('select consume_ai_credit_attempt($1,$2,$3) as result',[wallet,id,'correct'])).rows[0].result
    const finish=(usage,wallet='wallet')=>db.query('select complete_ai_credit_attempt($1,$2) as completed',[wallet,usage])
    const returnAttempt=(usage,wallet='wallet')=>db.query('select refund_ai_credit_attempt($1,$2) as result',[wallet,usage])
    const recovery=()=>db.query('select recover_pending_ai_credits() as recovered')
    const expire=()=>db.exec("update ai_credit_recovery set recover_after=now()-interval '1 second'")
    await t.test('debit and recovery record commit together; duplicate debit uses the same attempt',()=>fixture([100,0,0],async()=>{
      const a=await attempt(),b=await attempt()
      assert.equal(b.already_processed,true)
      assert.equal(a.usage_transaction_id,b.usage_transaction_id)
      assert.equal((await db.query('select count(*)::integer as n from ai_credit_recovery')).rows[0].n,1)
      assert.equal((await balance()).free_credits,90)
    }))
    await t.test('successful completion prevents scheduled and duplicate failure refunds',()=>fixture([100,0,0],async()=>{
      const a=await attempt()
      assert.equal((await finish(a.usage_transaction_id)).rows[0].completed,true)
      await expire();await recovery();await returnAttempt(a.usage_transaction_id)
      assert.equal((await balance()).free_credits,90)
      assert.equal((await db.query('select state from ai_credit_recovery')).rows[0].state,'completed')
    }))
    await t.test('an interrupted function is recovered after its lease, never before, exactly once',()=>fixture([3,4,100],async()=>{
      const before=await balance()
      await attempt();await recovery()
      assert.notDeepEqual(await balance(),before)
      await expire();await recovery();await recovery()
      assert.deepEqual(await balance(),before)
      assert.equal((await db.query('select state from ai_credit_recovery')).rows[0].state,'refunded')
    }))
    await t.test('late refunds and completion from an earlier attempt never affect the retry',()=>fixture([100,0,0],async()=>{
      const a=await attempt();await returnAttempt(a.usage_transaction_id)
      const b=await attempt()
      assert.notEqual(a.usage_transaction_id,b.usage_transaction_id)
      await returnAttempt(a.usage_transaction_id)
      assert.equal((await finish(a.usage_transaction_id)).rows[0].completed,false)
      assert.equal((await balance()).free_credits,90)
      await finish(b.usage_transaction_id);await expire();await recovery()
      assert.equal((await balance()).free_credits,90)
    }))
    await t.test('three refunds preserve three distinct ledger pairs and original request correlation',()=>fixture([100,0,0],async()=>{
      for(let i=0;i<3;i++){const a=await attempt();await returnAttempt(a.usage_transaction_id)}
      const usage=(await db.query("select * from credit_transactions where transaction_type='server_ai_usage'")).rows
      const refunds=(await db.query("select * from credit_transactions where transaction_type='server_ai_refund'")).rows
      assert.equal(usage.length,3);assert.equal(refunds.length,3)
      assert.equal(new Set(refunds.map(r=>r.metadata.usage_transaction_id)).size,3)
      assert.equal(refunds.reduce((sum,r)=>sum+r.free_delta,0),30)
      assert.equal(usage.filter(r=>r.metadata.request_id==='request').length,2)
      assert.equal((await balance()).free_credits,100)
    }))
    await t.test('maximum length request IDs remain refundable across retries',()=>fixture([100,0,0],async()=>{
      for(let i=0;i<3;i++){const a=await attempt('x'.repeat(128));await returnAttempt(a.usage_transaction_id)}
      assert.equal((await balance()).free_credits,100)
    }))
    await t.test('failed recovery remains pending and later recovers without partial balance changes',()=>fixture([100,0,0],async()=>{
      await attempt();await expire()
      await db.exec(`create function fail_recovery() returns trigger language plpgsql as $$
        begin if new.transaction_type='server_ai_refund' then raise exception 'fixture write failure'; end if; return new; end $$;
        create trigger fail_recovery before insert on credit_transactions for each row execute function fail_recovery();`)
      await recovery()
      assert.equal((await balance()).free_credits,90)
      const state=(await db.query('select state,retry_count from ai_credit_recovery')).rows[0]
      assert.deepEqual(state,{state:'pending',retry_count:1})
      await db.exec('drop trigger fail_recovery on credit_transactions')
      await expire();await recovery()
      assert.equal((await balance()).free_credits,100)
    }))
    await t.test('failure to save the recovery row rolls back the debit',()=>fixture([100,0,0],async()=>{
      await db.exec(`create function fail_recovery_insert() returns trigger language plpgsql as $$
        begin raise exception 'fixture recovery storage unavailable'; end $$;
        create trigger fail_recovery_insert before insert on ai_credit_recovery for each row execute function fail_recovery_insert();
        savepoint debit;`)
      await assert.rejects(attempt(),/storage unavailable/)
      await db.exec('rollback to savepoint debit')
      assert.equal((await balance()).free_credits,100)
      assert.equal((await db.query('select count(*)::integer as n from credit_transactions')).rows[0].n,0)
    }))
    await t.test('another wallet cannot finish or refund an attempt',()=>fixture([100,0,0],async()=>{
      const a=await attempt()
      assert.equal((await finish(a.usage_transaction_id,'other')).rows[0].completed,false)
      await db.exec('savepoint ownership_v2')
      await assert.rejects(returnAttempt(a.usage_transaction_id,'other'),/not found/)
      await db.exec('rollback to savepoint ownership_v2')
      assert.equal((await balance()).free_credits,90)
    }))
    await t.test('public callers cannot access recovery records or financial RPCs',async()=>{
      const r=(await db.query(`select relrowsecurity from pg_class where oid='ai_credit_recovery'::regclass`)).rows[0]
      assert.equal(r.relrowsecurity,true)
      for(const role of ['anon','authenticated']) {
        assert.equal((await db.query("select has_table_privilege($1,'ai_credit_recovery','SELECT') as allowed",[role])).rows[0].allowed,false)
        for(const fn of ['consume_ai_credit_attempt(text,text,text)','complete_ai_credit_attempt(text,uuid)','refund_ai_credit_attempt(text,uuid)','recover_pending_ai_credits()']) {
          assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,fn])).rows[0].allowed,false)
        }
      }
    })
  } finally {await db.close()}
})
