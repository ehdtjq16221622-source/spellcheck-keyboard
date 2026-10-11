import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const source = read('release/_shared/subscription_alerts.ts');
const api = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
globalThis.Deno = { env: { get: k => ({ TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: 'test' })[k] } };

function database() {
  const rows = new Map();
  return { rows, from(table) {
    assert.equal(table, 'telegram_alert_logs');
    let filters = [], patch;
    const result = () => {
      const matches = [...rows.values()].filter(r => filters.every(([k,v]) => r[k] === v));
      if (patch) matches.forEach(r => Object.assign(r, patch));
      return { data: matches, error: null };
    };
    const q = {
      async insert(row) {
        if (rows.has(row.idempotency_key)) return { error: { code: '23505' } };
        rows.set(row.idempotency_key, { ...row }); return { error: null };
      },
      select() { return q; }, update(p) { patch = p; return q; },
      eq(k,v) { filters.push([k,v]); return q; },
      async maybeSingle() { const r = result(); return { ...r, data: r.data[0] }; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve,reject); },
    }; return q;
  } };
}

test('production credit, Apple and wallet helpers unchanged byte-for-byte', () => {
  for (const file of readdirSync(new URL('baseline/_shared/', import.meta.url))) {
    assert.equal(read(`baseline/_shared/${file}`), read(`release/_shared/${file}`));
  }
  let release = read('release/sync_subscription_ios/index.ts')
    .replace('logSubscriptionAudit as writeSubscriptionAudit', 'logSubscriptionAudit')
    .replace("import { deferDiagnostic, reportFailure } from '../_shared/subscription_alerts.ts'\n", '')
    .replace(/  const events: Record<string, unknown>\[\] = \[\]\n[\s\S]*?\n  let auditStage/, '  let auditStage')
    .replace("    if (wallet.authenticated) events.push({ event: 'wallet_authenticated' })\n", '')
    .replace(/  } finally \{[\s\S]*?\n  }\n\}\)/, '  }\n})');
  assert.equal(release, read('baseline/sync_subscription_ios/index.ts'));
});

test('all release TypeScript files parse', () => {
  for (const folder of ['_shared', 'sync_subscription_ios', 'subscription_monitor']) {
    for (const file of readdirSync(new URL(`release/${folder}/`, import.meta.url))) {
      stripTypeScriptTypes(read(`release/${folder}/${file}`));
    }
  }
});

test('only failed audit events produce incident summaries', () => {
  assert.equal(api.summarizeFailure([{ event: 'sync_completed' }]), null);
  const result = api.summarizeFailure([
    { event: 'request_accepted', walletFingerprint: 'hashed' },
    { event: 'verification_completed', environment: 'Sandbox' },
    { event: 'rejected', auditId: 'diagnostic', stage: 'plan_change_verification', failureCode: 'apple_plan_not_confirmed' },
  ]);
  assert.equal(result.environment, 'Sandbox'); assert.equal(result.wallet, 'hashed');
  assert.equal(result.auditId, 'diagnostic');
});

test('concurrent retries send once; delivered incidents never resend', async () => {
  const db = database(); let sent = 0;
  globalThis.fetch = async () => { sent++; return Response.json({ ok: true }); };
  await Promise.all([api.sendIncident(db,'key','safe'),api.sendIncident(db,'key','safe')]);
  await api.sendIncident(db,'key','safe');
  assert.equal(sent,1); assert.equal(db.rows.get('key').delivery_status,'delivered');
});

test('failed Telegram response is not delivered; stale record retries', async () => {
  const db = database(); globalThis.fetch = async () => Response.json({ ok:false });
  await assert.rejects(api.sendIncident(db,'key','safe'), /alert_delivery_failed/);
  assert.equal(db.rows.get('key').delivery_status,'unknown');
  db.rows.get('key').sent_at = new Date(Date.now()-600_000).toISOString();
  globalThis.fetch = async () => Response.json({ ok:true });
  assert.equal(await api.sendIncident(db,'key','safe'),true);
});

test('pre-auth caller IDs cannot create separate incidents or leak into messages', async () => {
  const db = database(); let sent = 0;
  globalThis.fetch = async (_url, options) => { sent++; assert.ok(!options.body.includes('raw-wallet')); return Response.json({ok:true}); };
  for (const wallet of ['raw-wallet-a','raw-wallet-b']) await api.reportFailure(db,[
    {event:'request_accepted',walletFingerprint:wallet},
    {event:'sync_failed',auditId:'safe-id',stage:'wallet_resolution',failureCode:'wallet_access_rejected'},
  ]);
  assert.equal(sent,1);
});

test('grant keys preserve both atomic and legacy formats, missing is unknown', () => {
  assert.equal(api.grantKey({purchase_token:'t',product_id:'p',last_cycle_key:'c'}),'t:p:c');
  assert.equal(api.grantKey({purchase_token:'t',product_id:'p',last_cycle_key:'t:p:c'}),'t:p:c');
  assert.equal(api.grantKey({purchase_token:'t',product_id:'p'}),null);
});

test('diagnostic exceptions never reject the caller', async () => {
  let pending; globalThis.EdgeRuntime = {waitUntil(p) { pending=p; }};
  const saved = console.error; console.error=()=>{};
  try { api.deferDiagnostic(async()=>{throw Error('private error');}); await pending; }
  finally {console.error=saved;}
});

async function monitor({ headers = {}, count = 1, rows = [{purchase_token:'t',product_id:'p',last_cycle_key:'c'}], grant = true, queryError = false } = {}) {
  let handler; const alerts = [], queries = [];
  globalThis.Deno = { env:{get:k=>({SUPABASE_SERVICE_ROLE_KEY:'service',SUBSCRIPTION_MONITOR_SECRET:'monitor',SUPABASE_URL:'https://example.invalid'})[k]},serve:h=>{handler=h;} };
  globalThis.__alerts = { ...api, sendIncident: async (_db,key,message)=>{ alerts.push({key,message});return true; } };
  globalThis.__createClient = () => ({from(table) {
    const q = {select(){return q;},eq(k,v){queries.push([table,k,v]);return q;},like(){return q;},gt(){return q;},lt(){return q;},order(){return q;},limit(){return q;},
      then(resolve,reject){return Promise.resolve({error:queryError?{}:null,count,
        data:table==='device_subscriptions'?rows:table==='credit_transactions'?(grant?[{id:'ledger'}]:[]):[]}).then(resolve,reject);}};
    return q;
  }});
  const code = stripTypeScriptTypes(read('release/subscription_monitor/index.ts')
    .replace(/^import.*createClient.*$/m,'const createClient = globalThis.__createClient;')
    .replace(/^import.*subscription_alerts.*$/m,'const { ALERT_TYPE, fingerprint, grantKey, sendIncident } = globalThis.__alerts;'));
  await import(`data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`);
  const response=await handler(new Request('https://example.invalid',{method:'POST',headers,body:'{}'}));
  return {response,alerts,queries};
}

test('monitor rejects unauthorized invocation without reading tables', async()=>{
  const r=await monitor();assert.equal(r.response.status,401);assert.equal(r.queries.length,0);
});
test('monitor checks exact cycle without inferring loss from zero balance',async()=>{
  const r=await monitor({headers:{'x-monitor-secret':'monitor'}});
  assert.equal(r.response.status,200);assert.equal((await r.response.json()).matched,1);
  assert.equal(r.alerts.length,0);assert.ok(r.queries.some(q=>q[1]==='idempotency_key'&&q[2]==='t:p:c'));
});
test('monitor marks missing evidence, alerts without private keys',async()=>{
  const r=await monitor({headers:{Authorization:'Bearer service'},grant:false});
  assert.equal((await r.response.json()).missing,1);assert.equal(r.alerts.length,1);
  assert.ok(!JSON.stringify(r.alerts).includes('t:p:c'));
});
test('monitor does not report success on incomplete scan or query failure',async()=>{
  for(const options of [{count:2},{queryError:true}]) {
    const r=await monitor({headers:{'x-monitor-secret':'monitor'},...options});assert.equal(r.response.status,500);
  }
});
