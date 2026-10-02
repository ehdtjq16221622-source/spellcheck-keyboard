import { assertRejects } from 'jsr:@std/assert@1'
import { verifyAppleTransactionJws } from '../functions/_shared/apple_subscription_status.ts'

Deno.test('Apple subscription verifier loads in the Edge runtime without Node globals', async () => {
  await assertRejects(
    () => verifyAppleTransactionJws('', 'com.kingboard.app'),
    Error,
    'missing or too large',
  )
})
