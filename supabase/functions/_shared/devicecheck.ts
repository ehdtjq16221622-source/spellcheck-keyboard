import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'

const DEVICECHECK_URL = 'https://api.devicecheck.apple.com/v1'

function credentials(): { keyId: string; teamId: string; privateKey: string } {
  const keyId = Deno.env.get('DEVICECHECK_KEY_ID')
  const teamId = Deno.env.get('DEVICECHECK_TEAM_ID')
  const privateKey = Deno.env.get('DEVICECHECK_PRIVATE_KEY')
  if (!keyId || !teamId || !privateKey) throw new Error('DeviceCheck is not configured')
  return { keyId, teamId, privateKey }
}

function validToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 32 && token.length <= 8192 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(token)
}

async function request(path: 'query_two_bits' | 'update_two_bits', token: string, bits?: { bit1: true }) {
  if (!validToken(token)) throw new Error('Invalid DeviceCheck token')
  const { keyId, teamId, privateKey } = credentials()
  const key = await importPKCS8(privateKey.replace(/\\n/g, '\n'), 'ES256')
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .sign(key)
  const result = await fetch(`${DEVICECHECK_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_token: token, transaction_id: crypto.randomUUID(),
      timestamp: Date.now(), ...bits }),
  })
  if (!result.ok) throw new Error(`DeviceCheck ${path} failed: ${result.status}`)
  return result
}

export async function isBonusCanaryDevice(token: string): Promise<boolean> {
  const result = await request('query_two_bits', token)
  const data = await result.json()
  if (typeof data?.bit1 !== 'boolean') throw new Error('DeviceCheck state unavailable')
  return data.bit1
}

export async function enrollBonusCanaryDevice(token: string): Promise<void> {
  await request('update_two_bits', token, { bit1: true })
  if (!(await isBonusCanaryDevice(token))) throw new Error('DeviceCheck enrollment not confirmed')
}
