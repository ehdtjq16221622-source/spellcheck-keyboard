import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export class WalletAccessError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function walletTokenHash(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function resolveCreditWallet(
  req: Request,
  supabase: SupabaseClient,
  requestedId: string | null | undefined,
): Promise<{ walletId: string; authenticated: boolean }> {
  if (typeof requestedId !== 'string' || requestedId.length === 0 || requestedId.length > 512) {
    throw new WalletAccessError('Wallet ID is required.', 400)
  }
  if (Deno.env.get('WALLET_SESSIONS_ENABLED') !== 'true') {
    if (requestedId.startsWith('v2:')) {
      throw new WalletAccessError('앱을 최신 버전으로 업데이트해 주세요.', 409)
    }
    return { walletId: requestedId, authenticated: false }
  }

  const bearer = req.headers.get('Authorization')
  // Older Android clients send the public Supabase JWT in this header.
  // Wallet sessions use a distinct fixed-length random token.
  const token = bearer ? /^Bearer ([0-9a-f]{64})$/.exec(bearer)?.[1] : undefined
  if (token) {
    const { data: session, error } = await supabase
      .from('credit_wallet_sessions')
      .select('wallet_id, apple_sub, expires_at, revoked_at')
      .eq('token_hash', await walletTokenHash(token))
      .maybeSingle()
    if (error) throw error
    if (!session && requestedId.startsWith('v2:')) {
      const { data: credential, error: credentialError } = await supabase
        .from('wallet_v2_credentials')
        .select('secret_hash, state')
        .eq('wallet_id', requestedId)
        .maybeSingle()
      if (credentialError) throw credentialError
      if (credential?.secret_hash === await walletTokenHash(token) &&
          credential.state === 'active') {
        const { data: guest, error: guestError } = await supabase
          .from('device_credits')
          .select('apple_user_id')
          .eq('device_id', requestedId)
          .maybeSingle()
        if (guestError) throw guestError
        if (guest && guest.apple_user_id === null) {
          return { walletId: requestedId, authenticated: true }
        }
      }
    }
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) {
      throw new WalletAccessError('Wallet session expired.', 401)
    }
    const { data: owner, error: ownerError } = await supabase
      .from('device_credits')
      .select('apple_user_id')
      .eq('device_id', session.wallet_id)
      .maybeSingle()
    if (ownerError) throw ownerError
    if (!owner || owner.apple_user_id !== session.apple_sub) {
      throw new WalletAccessError('Wallet session no longer matches the account.', 401)
    }
    if (requestedId && requestedId !== session.wallet_id) {
      throw new WalletAccessError('Requested wallet does not match the account.', 409)
    }
    return { walletId: session.wallet_id, authenticated: true }
  }

  const { data: protectedWallet, error } = await supabase
    .from('credit_protected_wallets')
    .select('wallet_id')
    .eq('wallet_id', requestedId)
    .maybeSingle()
  if (error) throw error
  if (protectedWallet || requestedId.startsWith('v2:')) {
    throw new WalletAccessError('앱을 최신 버전으로 업데이트해 주세요.', 409)
  }
  return { walletId: requestedId, authenticated: false }
}
