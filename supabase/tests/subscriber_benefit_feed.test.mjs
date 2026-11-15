import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {runInNewContext} from 'node:vm'
import {test} from 'node:test'

const source=readFileSync(new URL('../functions/get_active_notice/index.ts',import.meta.url),'utf8')
const now=Date.parse('2026-10-25T00:00:00Z')
const campaign={id:'new-app',app_name:'새 앱',title:'구독자 혜택',body:'무료 이용권',app_url:'https://apps.apple.com/kr/app/id123',starts_at:null,ends_at:null}
async function feed({notices=[],campaigns=[],campaignError=false,throwCampaign=false}={}) {
  let handler
  class Clock extends Date { static now(){return now} }
  const db={from:table=>{
    const query={
      select(){return this},eq(column,value){assert.equal(column,'is_active');assert.equal(value,true);return this},
      order(){return this},limit(){return this},
      then(resolve,reject){
        if(table==='subscriber_benefit_campaigns' && throwCampaign)return Promise.reject(new Error('offline')).then(resolve,reject)
        return Promise.resolve({data:table==='app_notices'?notices:campaigns,error:table!=='app_notices'&&campaignError?new Error('offline'):null}).then(resolve,reject)
      }
    };return query
  }}
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm,'')),{
    Deno:{env:{get:()=>''},serve:h=>handler=h},createClient:()=>db,Date:Clock,URL,Response,console:{warn(){}}
  })
  const response=await handler(new Request('https://fixture.invalid',{method:'POST'}))
  assert.equal(response.status,200)
  return response.json()
}
test('no campaign rows keeps benefit off and regular notice intact',async()=>{
  const result=await feed({notices:[{id:'notice',title:'공지',body:'본문'}]})
  assert.equal(result.active,true);assert.equal(result.id,'notice');assert.equal(result.subscriber_benefit,null)
})
test('a benefit can be returned without an operational notice',async()=>{
  const result=await feed({campaigns:[campaign]})
  assert.equal(result.active,false);assert.equal(result.subscriber_benefit.id,campaign.id)
})
for(const options of [{campaignError:true},{throwCampaign:true}]) {
  test('benefit lookup failure preserves operational notice: '+JSON.stringify(options),async()=>{
    const result=await feed({...options,notices:[{id:'notice',title:'공지',body:'본문'}]})
    assert.equal(result.id,'notice');assert.equal(result.subscriber_benefit,null)
  })
}
test('future, expired and invalid campaign periods are ignored',async()=>{
  for(const dates of [{starts_at:'2026-10-26T00:00:00Z'},{ends_at:'2026-10-25T00:00:00Z'},{ends_at:'invalid'}]) {
    assert.equal((await feed({campaigns:[{...campaign,...dates}]})).subscriber_benefit,null)
  }
})
test('untrusted and credential-bearing destinations are rejected',async()=>{
  for(const app_url of ['http://apps.apple.com/app/id123','https://example.com','https://apps.apple.com.evil.test','https://user@private.test','javascript:alert(1)']) {
    assert.equal((await feed({campaigns:[{...campaign,app_url}]})).subscriber_benefit,null)
  }
})
test('the feed provides marketing copy, never account IDs or an entitlement grant',async()=>{
  const result=await feed({campaigns:[{...campaign,secret:'not-selected-by-real-query'}]})
  assert.equal('account_id' in result.subscriber_benefit,false)
  assert.equal('granted' in result.subscriber_benefit,false)
})
