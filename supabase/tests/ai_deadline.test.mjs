import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const read = p => readFileSync(new URL(p,import.meta.url),'utf8')
const requestId = '12345678-1234-4abc-8def-123456789abc'
const shared = read('../functions/_shared/ai_deadline.ts')
const creditSource = read('../functions/correct/_shared/credits.ts')
const flush = async () => { for (let i=0;i<5;i++) await new Promise(setImmediate) }

function harness(endpoint, { delays=[10_000], statuses=[200], alreadyProcessed=false, ignoreAbort=false, bodyDelay=0, refundError=false, refundFailures=0, completionFailures=0 }={}) {
  let now=0, next=0, handler, balance=1000
  const timers=new Map(), ledger=new Map(), rows=[], logs=[], requests=[], pending=[]
  let charges=0, refunds=0
  const setTimer=(callback,ms)=>{const id=++next;timers.set(id,{at:now+ms,callback});return id}
  const clearTimer=id=>timers.delete(id)
  const db={
    from:()=>({insert:async row=>{rows.push(row);return {error:null}}}),
    async rpc(name,args) {
      const id=args.p_request_id
      if(name==='consume_ai_credit_attempt') {
        const existing=ledger.get(id)
        const cost={correct:10,formal:30,translate:20}[args.p_kind]
        if(!existing) {balance-=cost;charges++;ledger.set(id,{refunded:false,completed:false,cost})}
        return {data:{accepted:true,already_processed:alreadyProcessed||Boolean(existing),usage_transaction_id:id,free_credits_remaining:balance,paid_credits_remaining:0},error:null}
      }
      const attempt=ledger.get(args.p_usage_id)
      if(name==='complete_ai_credit_attempt') {
        if(completionFailures-->0) return {data:null,error:new Error('fixture completion unavailable')}
        if(attempt.refunded) return {data:false,error:null}
        attempt.completed=true
        return {data:true,error:null}
      }
      assert.equal(name,'refund_ai_credit_attempt')
      if(refundError || refundFailures-->0) return {data:null,error:new Error('fixture refund unavailable')}
      if(!attempt.refunded && !attempt.completed) {balance+=attempt.cost;refunds++;attempt.refunded=true}
      return {data:[{free_credits_remaining:balance,paid_credits_remaining:0,refunded:attempt.refunded}],error:null}
    },
  }
  class ClockDate extends Date { static now(){return now} }
  const context={
    Request,Response,TextEncoder,crypto,AbortController,Date:ClockDate,
    setTimeout:setTimer,clearTimeout:clearTimer,
    console:Object.fromEntries(['log','warn','error'].map(k=>[k,(...args)=>logs.push(args)])),
    EdgeRuntime:{waitUntil:task=>pending.push(task)},
    Deno:{env:{get:()=> 'fixture'},serve:h=>{handler=h}},
    createClient:()=>db,
    resolveCreditWallet:async()=>({walletId:'fixture-wallet',authenticated:true}),
    WalletAccessError:class extends Error {constructor(message,status){super(message);this.status=status}},
    parseProofingEdits:()=>[],applyValidatedProofingEdits:text=>({result:text,rejected:[]}),
    fetch:async(url,init)=>{
      const index=requests.length;requests.push({url,init,at:now})
      const delay=delays[Math.min(index,delays.length-1)]
      return await new Promise((resolve,reject)=>{
        const cancelled=()=>{if(!ignoreAbort){clearTimer(timer);reject(new Error('aborted'))}}
        const timer=setTimer(()=>{
          init.signal?.removeEventListener('abort',cancelled)
          const json=String(url).includes('openai')
            ? {status:'completed',output_text:endpoint==='translate'?JSON.stringify({translation:'result',pronunciation_ko:'발음'}):'원문'}
            : {candidates:[{finishReason:'STOP',content:{parts:[{text:'원문'}]}}]}
          const response=Response.json(json,{status:statuses[Math.min(index,statuses.length-1)]})
          if(bodyDelay) {
            response.json=()=>new Promise(resolve=>setTimer(()=>resolve(json),bodyDelay))
            response.text=()=>new Promise(resolve=>setTimer(()=>resolve(JSON.stringify(json)),bodyDelay))
          }
          resolve(response)
        },delay)
        init.signal?.addEventListener('abort',cancelled,{once:true})
      })
    },
  }
  const source=endpoint==='correct' && process.env.KINGBOARD_CORRECT_CANDIDATE
    ? readFileSync(process.env.KINGBOARD_CORRECT_CANDIDATE,'utf8') : read(`../functions/${endpoint}/index.ts`)
  const program=shared.replace(/^export /gm,'')+'\n'+creditSource.replace(/^import .*$/gm,'').replace(/^export /gm,'')+'\n'+source.replace(/^import .*$/gm,'')
  runInNewContext(stripTypeScriptTypes(program),context)
  return {
    rows,logs,requests,get charges(){return charges},get refunds(){return refunds},get balance(){return balance},
    recoverPending() {
      for(const attempt of ledger.values()) {
        if(!attempt.refunded && !attempt.completed) {balance+=attempt.cost;refunds++;attempt.refunded=true}
      }
    },
    async start(overrides={}) {
      let done
      const task=handler(new Request('https://fixture.invalid/'+endpoint,{method:'POST',body:JSON.stringify({
        text:'원문',deviceId:'fixture-wallet',requestId,targetLang:'en',...overrides,
      })})).then(async response=>{done={status:response.status,body:await response.json()};return done})
      await flush()
      return {task,get done(){return done}}
    },
    async advance(ms) {
      const target=now+ms
      for(;;) {
        const due=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0]
        if(!due)break
        now=due[1].at;timers.delete(due[0]);due[1].callback();await flush()
      }
      now=target;await flush();await Promise.all(pending)
    },
  }
}

for(const [endpoint,extra] of [['correct',{}],['correct',{formalMode:true,formalLevel:'smart'}],['correct',{formalMode:true,formalLevel:'custom',customPrompt:'부드럽게'}],['translate',{}]]) {
  for(const seconds of [9,9.999,10,10.001,26,60]) {
    test(`${endpoint} ${extra.formalLevel??'default'} virtual ${seconds}s uses one total 10s budget and exact refund key`,async()=>{
      const h=harness(endpoint,{delays:[seconds*1000]})
      const r=await h.start(extra);await h.advance(70_000)
      const success=seconds<10, cost=extra.formalMode?30:endpoint==='translate'?20:10
      assert.equal(r.done.status,success?200:504)
      assert.equal(h.charges,1);assert.equal(h.refunds,success?0:1)
      assert.equal(h.balance,success?1000-cost:1000)
      assert.equal(h.rows.length,success?0:1)
      if(!success) {
      assert.equal(h.rows[0].request_id,requestId)
      assert.equal(h.rows[0].diagnostic_id,requestId)
      assert.equal(h.rows[0].duration_ms,10_000)
      assert.equal(h.rows[0].outcome,'error')
      }
      assert.ok(h.requests.every(x=>x.init.signal instanceof AbortSignal))
    })
  }
}
test('Gemini transient retry succeeds inside the same deadline',async()=>{
  const h=harness('correct',{delays:[4_000,5_000],statuses:[503,200]})
  const r=await h.start();await h.advance(30_000)
  assert.equal(r.done.status,200);assert.equal(h.requests.length,2)
  assert.equal(h.requests[1].at,4_250);assert.equal(h.refunds,0)
  assert.equal(h.rows.length,0)
})
test('retry does not restart the deadline, even if the second call could succeed later',async()=>{
  const h=harness('correct',{delays:[6_000,5_000],statuses:[503,200]})
  const r=await h.start();await h.advance(60_000)
  assert.equal(r.done.status,504);assert.equal(h.requests.length,2);assert.equal(h.refunds,1)
  assert.equal(h.rows[0].duration_ms,10_000)
})
test('a late provider that ignores abort cannot turn a refunded failure into success',async()=>{
  const h=harness('translate',{delays:[60_000],ignoreAbort:true})
  const r=await h.start();await h.advance(10_000)
  assert.equal(r.done.status,504);assert.equal(h.refunds,1)
  await h.advance(60_000)
  assert.equal(r.done.status,504);assert.equal(h.refunds,1);assert.equal(h.balance,1000)
})
test('duplicate request numbers never charge twice or refund the other invocation',async()=>{
  for(const delay of [9_000,26_000]) {
    const h=harness('correct',{delays:[delay]})
    const a=await h.start(),b=await h.start();await h.advance(60_000)
    assert.equal(a.done.status,delay<10_000?200:504);assert.equal(b.done.status,a.done.status)
    assert.equal(h.charges,1);assert.equal(h.refunds,delay<10_000?0:1)
  }
})
test('deadline helpers in both deploy bundles are identical and old slow rows remain nullable',()=>{
  assert.equal(read('../functions/correct/_shared/ai_deadline.ts'),shared)
  assert.equal(read('../functions/translate/_shared/ai_deadline.ts'),shared)
  const migration=read('../migrations/20261024080206_ai_request_deadline_correlation.sql')
  assert.match(migration,/add column if not exists request_id text/)
  assert.doesNotMatch(migration,/add column[^;\n]*\bnot null|delete from|truncate/i)
})

for(const endpoint of ['correct','translate']) {
  test(`${endpoint}: receiving headers does not exempt a stalled response body from the deadline`,async()=>{
    const h=harness(endpoint,{delays:[100],bodyDelay:20_000})
    const r=await h.start();await h.advance(10_000)
    assert.equal(r.done.status,504);assert.equal(h.refunds,1);assert.equal(h.balance,1000)
    await h.advance(20_000)
    assert.equal(r.done.status,504);assert.equal(h.refunds,1)
  })
  test(`${endpoint}: refund database failure is observable and must not be counted as refunded`,async()=>{
    const h=harness(endpoint,{delays:[60_000],refundError:true})
    const r=await h.start();await h.advance(60_000)
    assert.equal(r.done.status,504);assert.equal(h.refunds,0)
    assert.equal(h.balance,endpoint==='correct'?990:980)
    assert.ok(JSON.stringify(h.logs).toLowerCase().includes('refund_failed'))
    h.recoverPending()
    assert.equal(h.balance,1000)
    assert.equal(h.refunds,1)
    h.recoverPending()
    assert.equal(h.refunds,1)
  })
  test(`${endpoint}: transient refund failure retries without another debit`,async()=>{
    const h=harness(endpoint,{delays:[60_000],refundFailures:2})
    const r=await h.start();await h.advance(60_000)
    assert.equal(r.done.status,504);assert.equal(h.balance,1000);assert.equal(h.refunds,1)
  })
  test(`${endpoint}: completion retries and completed requests are not recovered`,async()=>{
    const h=harness(endpoint,{delays:[1000],completionFailures:2})
    const r=await h.start();await h.advance(60_000)
    assert.equal(r.done.status,200)
    h.recoverPending()
    assert.equal(h.refunds,0)
    assert.equal(h.balance,endpoint==='correct'?990:980)
  })
  test(`${endpoint}: permanently failed completion returns an error and refunds`,async()=>{
    const h=harness(endpoint,{delays:[1000],completionFailures:100})
    const r=await h.start();await h.advance(60_000)
    assert.equal(r.done.status,500);assert.equal(h.refunds,1);assert.equal(h.balance,1000)
  })
}

test('deadline also stops retry backoff before a second provider call',async()=>{
  const h=harness('correct',{delays:[9_900,100],statuses:[503,200]})
  const r=await h.start();await h.advance(30_000)
  assert.equal(r.done.status,504);assert.equal(h.requests.length,1);assert.equal(h.refunds,1)
})
