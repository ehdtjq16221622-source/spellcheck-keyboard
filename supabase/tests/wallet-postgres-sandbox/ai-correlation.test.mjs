import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('AI correlation migration preserves existing rows and permits linked translation attempts',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create table ai_slow_requests (
      id bigserial primary key, kind text not null constraint ai_slow_requests_kind_check check(kind='correct'),
      duration_ms integer check(duration_ms>=0), outcome text check(outcome in ('ok','error')), created_at timestamptz default now());
      insert into ai_slow_requests(kind,duration_ms,outcome) values ('correct',12000,'ok');`)
    await db.exec(await readFile(new URL('../../migrations/20261024080206_ai_request_deadline_correlation.sql',import.meta.url),'utf8'))
    const before=(await db.query('select * from ai_slow_requests')).rows
    assert.equal(before.length,1);assert.equal(before[0].request_id,null);assert.equal(before[0].kind,'correct')
    const id='12345678-1234-4abc-8def-123456789abc'
    for(let i=0;i<2;i++) await db.query("insert into ai_slow_requests(kind,duration_ms,outcome,request_id,diagnostic_id) values ('translate',25000,'error',$1::text,($1::text)::uuid)",[id])
    assert.equal((await db.query('select count(*)::int as n from ai_slow_requests where request_id=$1',[id])).rows[0].n,2)
    await assert.rejects(db.exec("insert into ai_slow_requests(kind,duration_ms,outcome) values ('unrelated',1,'ok')"),/check constraint/)
    assert.equal((await db.query('select count(*)::int as n from ai_slow_requests')).rows[0].n,3)
  } finally {await db.close()}
})
