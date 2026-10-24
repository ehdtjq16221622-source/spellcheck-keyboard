import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts',import.meta.url),'utf8');
const start = source.indexOf("    if (body.action === 'rotate_session' || body.action === 'revoke_session') {");
const block = source.slice(start,source.indexOf("\n    if (body.action === 'resume_guest_merge')",start));
const execute = new Function('body','supabase','auditedRpc','walletTokenHash','isHexSecret','respond',
  'return (async () => {' + block + '})()');

test('rotation route accepts an expired token up to the RPC and returns the actual next-session expiry', async () => {
  const actualExpiry = new Date(Date.now()+86400000).toISOString();
  let rpcCalls=0;
  const db = { from(table) {
    assert.equal(table,'credit_wallet_sessions');
    return {select(columns) { return {eq(column, hash) { return {async maybeSingle() {
      assert.equal(column,'token_hash');
      return {data: hash==='old-hash' ? {apple_sub:'apple'} : {expires_at:actualExpiry},error:null};
    }}}}}};
  }};
  const rpc = async (name,args) => {
    rpcCalls++;
    assert.equal(name,'rotate_apple_wallet_session');
    assert.equal(args.p_old_hash,'old-hash');
    assert.equal(args.p_new_hash,'next-hash');
    return {data:'wallet',error:null};
  };
  const run = (override=rpc) => execute(
    {action:'rotate_session',sessionToken:'old',nextSessionToken:'next'},db,override,
    async token=>token+'-hash',()=>true,(body,status=200)=>({body,status}));
  const response=await run();
  assert.equal(response.status,200);
  assert.equal(response.body.walletId,'wallet');
  assert.equal(response.body.expiresAt,actualExpiry);
  assert.ok(response.body.expiresInSeconds<=86400);
  assert.equal(rpcCalls,1);
  assert.equal((await run(async()=>({error:{code:'P0001'}}))).status,401);
  const prefix=source.slice(source.lastIndexOf('const appleLinkEnabled',start),start);
  assert.doesNotMatch(prefix,/Date\.parse|expires_at\s*[<=>]/);
});
