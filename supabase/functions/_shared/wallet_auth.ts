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

// Legacy apps may request the Apple subject instead of the canonical wallet ID.
// Keep protection effective even when rollout flags are later turned off.
export async function requiresWalletSession(supabase: SupabaseClient, requestedId: string): Promise<boolean> {
  if (requestedId.startsWith('v2:')) return true
  const { data: protectedWallet, error } = await supabase
    .from('credit_protected_wallets').select('wallet_id')
    .eq('wallet_id', requestedId).maybeSingle()
  if (error) throw error
  if (protectedWallet) return true

  const { data: alias, error: aliasError } = await supabase
    .from('credit_wallet_aliases').select('canonical_wallet_id')
    .eq('source_wallet_id', requestedId).maybeSingle()
  if (aliasError) throw aliasError
  if (alias) return true

  const { data: linked, error: linkedError } = await supabase
    .from('device_credits').select('device_id')
    .eq('apple_user_id', requestedId).maybeSingle()
  if (linkedError) throw linkedError
  if (!linked) return false
  if (linked.device_id.startsWith('v2:')) {
    // A separate, untransferred legacy row is not an alias for the V2 wallet.
    // Direct protection and aliases above always take precedence.
    const { data: legacy, error: legacyError } = await supabase
      .from('device_credits').select('device_id, apple_user_id')
      .eq('device_id', requestedId).maybeSingle()
    if (legacyError) throw legacyError
    return !(legacy?.device_id === requestedId && legacy.apple_user_id === null)
  }
  const { data: protectedLinked, error: protectedLinkedError } = await supabase
    .from('credit_protected_wallets').select('wallet_id')
    .eq('wallet_id', linked.device_id).maybeSingle()
  if (protectedLinkedError) throw protectedLinkedError
  return Boolean(protectedLinked)
}

export async function resolveCreditWallet(
  req: Request,
  supabase: SupabaseClient,
  requestedId: string | null | undefined,
  forceWalletAuth = false,
): Promise<{ walletId: string; authenticated: boolean }> {
  if (typeof requestedId !== 'string' || requestedId.length === 0 || requestedId.length > 512) {
    throw new WalletAccessError('Wallet ID is required.', 400)
  }
  const sessionsEnabled = Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true'
  const requireAllWalletSessions = Deno.env.get('WALLET_REQUIRE_SESSION_FOR_ALL_WALLETS') === 'true'
  const bearer = req.headers.get('Authorization')
  // Older Android clients send the public Supabase JWT in this header.
  // Wallet sessions use a distinct fixed-length random token.
  const token = bearer ? /^Bearer ([0-9a-f]{64})$/.exec(bearer)?.[1] : undefined
  if (!sessionsEnabled && !requireAllWalletSessions && !forceWalletAuth && !token) {
    if (await requiresWalletSession(supabase, requestedId)) {
      throw new WalletAccessError('앱을 최신 버전으로 업데이트해 주세요.', 409)
    }
    return { walletId: requestedId, authenticated: false }
  }

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
      const { data: alias, error: aliasError } = await supabase
        .from('credit_wallet_aliases')
        .select('canonical_wallet_id, apple_sub')
        .eq('source_wallet_id', requestedId)
        .maybeSingle()
      if (aliasError) throw aliasError
      if (!alias || alias.canonical_wallet_id !== session.wallet_id ||
          alias.apple_sub !== session.apple_sub) {
        throw new WalletAccessError('Requested wallet does not match the account.', 409)
      }
    }
    return { walletId: session.wallet_id, authenticated: true }
  }

  if (requireAllWalletSessions || forceWalletAuth || await requiresWalletSession(supabase, requestedId)) {
    throw new WalletAccessError('앱을 최신 버전으로 업데이트해 주세요.', 409)
  }
  return { walletId: requestedId, authenticated: false }
}
