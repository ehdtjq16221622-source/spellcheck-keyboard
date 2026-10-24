import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const message = "킹보드 앱을 열고 '지갑 연결'에서 [연결]을 눌러 주세요."
const slugs = ['correct','translate','get_credits','daily_checkin','language_study_generate','redeem_coupon','sync_credit_usage','sync_subscription','sync_subscription_ios']
const root = new URL('../',import.meta.url)
const read = p => readFileSync(new URL(p,root),'utf8').replaceAll('\r\n','\n').trimEnd()
function files(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(e => e.isDirectory() ? files(join(directory,e.name)) : [join(directory,e.name)])
}
const normalized = s => s.replaceAll("'Wallet session expired.'",'"RECONNECT_COPY"')
  .replaceAll("'Wallet session no longer matches the account.'",'"RECONNECT_COPY"')
  .replaceAll(JSON.stringify(message),'"RECONNECT_COPY"')
for (const slug of ['_shared',...slugs]) {
  test(`${slug}: Korean reconnect copy changes no authorization logic`,async () => {
    const path = slug === '_shared' ? 'functions/_shared/wallet_auth.ts' : `functions/${slug}/_shared/wallet_auth.ts`
    const source = read(path)
    assert.ok(source.includes(JSON.stringify(message)))
    assert.doesNotMatch(source,/Wallet session expired\.|Wallet session no longer matches the account\./)
    if (slug !== '_shared') {
      const baseline = files(fileURLToPath(new URL(`live-functions/${slug}`,root))).find(p=>p.endsWith('wallet_auth.ts'))
      assert.equal(normalized(source), normalized(readFileSync(baseline,'utf8').replaceAll('\r\n','\n').trimEnd()))
    }
    const runnable = stripTypeScriptTypes(source.replace(/^import type .*$/m,''))
    const auth = await import(`data:text/javascript,${encodeURIComponent(runnable)}`)
    const error = new auth.WalletAccessError(message,401)
    assert.equal(error.status,401); assert.equal(error.message,message)
  })
}
