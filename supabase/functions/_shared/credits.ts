import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const DAILY_FREE = 50
export const PLAN1_DAILY_CREDITS = 5000
export const PLAN2_DAILY_CREDITS = 10000
export const MONTHLY_SUBSCRIPTION_CREDITS = 5000
export const REWARDED_AD_CREDITS = 500

const PLAN1_PRODUCT_IDS = new Set([
  'kingboard_monthly_500',
  'com.kingboard.app.monthly_basic',
])

const PLAN2_PRODUCT_IDS = new Set([
  'kingboard_monthly_1000',
  'com.kingboard.app.monthly_premium',
])

export type CreditSnapshot = {
  freeCredits: number
  paidCredits: number
  remaining: number
}

type CreditRpcResult = {
  ok?: boolean
  free_credits: number
  paid_credits: number
  remaining: number
}

type CreditRow = {
  device_id: string
  free_credits: number
  paid_credits: number
  last_reset_date: string
}

function todayInKst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function toSnapshot(row: Pick<CreditRow, 'free_credits' | 'paid_credits'>): CreditSnapshot {
  return {
    freeCredits: row.free_credits,
    paidCredits: row.paid_credits,
    remaining: row.free_credits + row.paid_credits,
  }
}

async function ensureCreditRow(
  supabase: SupabaseClient,
  deviceId: string
): Promise<CreditRow> {
  const today = todayInKst()
  const { data, error } = await supabase
    .from('device_credits')
    .select('device_id, free_credits, paid_credits, last_reset_date')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    const row: CreditRow = {
      device_id: deviceId,
      free_credits: DAILY_FREE,
      paid_credits: 0,
      last_reset_date: today,
    }
    const { error: insertError } = await supabase.from('device_credits').insert(row)
    if (insertError) throw insertError
    return row
  }

  if (data.last_reset_date < today) {
    const nextRow: CreditRow = {
      ...data,
      free_credits: DAILY_FREE,
      last_reset_date: today,
    }
    const { error: updateError } = await supabase
      .from('device_credits')
      .update({
        free_credits: DAILY_FREE,
        last_reset_date: today,
        updated_at: new Date().toISOString(),
      })
      .eq('device_id', deviceId)
    if (updateError) throw updateError
    return nextRow
  }

  return data
}

export async function getCredits(
  supabase: SupabaseClient,
  deviceId: string
): Promise<CreditSnapshot> {
  return toSnapshot(await ensureCreditRow(supabase, deviceId))
}

export async function checkAndDeduct(
  supabase: SupabaseClient,
  deviceId: string,
  cost: number
): Promise<{ allowed: boolean; snapshot: CreditSnapshot }> {
  // row 보장 + 일 리셋 처리 (멱등)
  await ensureCreditRow(supabase, deviceId)

  // atomic UPDATE: 잔액 검사 + 차감을 단일 SQL로 처리 (race-condition safe)
  const { data, error } = await supabase.rpc('deduct_credits', {
    p_device_id: deviceId,
    p_cost: cost,
  })
  if (error) throw error

  const result = data as {
    ok: boolean
    free_credits: number
    paid_credits: number
    remaining: number
  }

  return {
    allowed: result.ok,
    snapshot: {
      freeCredits: result.free_credits,
      paidCredits: result.paid_credits,
      remaining: result.remaining,
    },
  }
}

export async function addPaidCredits(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number
): Promise<CreditSnapshot> {
  try {
    const { data, error } = await supabase.rpc('grant_paid_credits', {
      p_device_id: deviceId,
      p_amount: amount,
    })
    if (error) throw error

    const result = data as CreditRpcResult
    if (result) {
      return {
        freeCredits: result.free_credits,
        paidCredits: result.paid_credits,
        remaining: result.remaining,
      }
    }
  } catch (_error) {
    // Fallback until SQL is applied.
  }

  const row = await ensureCreditRow(supabase, deviceId)
  const nextPaid = row.paid_credits + amount

  const { error } = await supabase
    .from('device_credits')
    .update({
      paid_credits: nextPaid,
      updated_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId)
  if (error) throw error

  return {
    freeCredits: row.free_credits,
    paidCredits: nextPaid,
    remaining: row.free_credits + nextPaid,
  }
}

export async function setMonthlySubscriptionCredits(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number = MONTHLY_SUBSCRIPTION_CREDITS
): Promise<CreditSnapshot> {
  return addPaidCredits(supabase, deviceId, amount)
}

export function subscriptionCreditsForProduct(productId: string): number {
  if (PLAN2_PRODUCT_IDS.has(productId)) {
    return PLAN2_DAILY_CREDITS
  }
  if (PLAN1_PRODUCT_IDS.has(productId)) {
    return PLAN1_DAILY_CREDITS
  }
  return MONTHLY_SUBSCRIPTION_CREDITS
}

export async function recordRewardAdClaim(
  supabase: SupabaseClient,
  deviceId: string,
  cooldownMinutes = 5,
  dailyLimit = 20
): Promise<{ allowed: boolean; reason?: 'cooldown' | 'daily_limit'; retryAfterSeconds?: number }> {
  try {
    const now = new Date()
    const cooldownCutoff = new Date(now.getTime() - cooldownMinutes * 60_000).toISOString()
    const dayStart = new Date(now.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00')
    const dayStartIso = new Date(dayStart.setHours(0, 0, 0, 0)).toISOString()

    const [{ data: recent, error: recentError }, { count, error: countError }] = await Promise.all([
      supabase
        .from('reward_ad_log')
        .select('rewarded_at')
        .eq('device_id', deviceId)
        .gte('rewarded_at', cooldownCutoff)
        .order('rewarded_at', { ascending: false })
        .limit(1),
      supabase
        .from('reward_ad_log')
        .select('*', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .gte('rewarded_at', dayStartIso),
    ])

    if (recentError) throw recentError
    if (countError) throw countError

    if (recent && recent.length > 0) {
      const last = new Date(recent[0].rewarded_at)
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((last.getTime() + cooldownMinutes * 60_000 - now.getTime()) / 1000),
      )
      return { allowed: false, reason: 'cooldown', retryAfterSeconds }
    }

    if ((count ?? 0) >= dailyLimit) {
      return { allowed: false, reason: 'daily_limit' }
    }

    return { allowed: true }
  } catch (_error) {
    return { allowed: true }
  }
}

export async function persistRewardAdClaim(
  supabase: SupabaseClient,
  deviceId: string,
  creditsGiven: number
): Promise<void> {
  try {
    const { error } = await supabase.from('reward_ad_log').insert({
      device_id: deviceId,
      credits_given: creditsGiven,
    })
    if (error) throw error
  } catch (_error) {
    // Don't fail the main request while SQL rollout catches up.
  }
}

export async function redeemCouponOnce(
  supabase: SupabaseClient,
  deviceId: string,
  couponCode: string,
  creditsGiven: number
): Promise<{ allowed: boolean }> {
  try {
    const { error } = await supabase.from('coupon_redemptions').insert({
      device_id: deviceId,
      coupon_code: couponCode,
      credits_given: creditsGiven,
    })
    if (error) {
      const message = String(error.message).toLowerCase()
      if (message.includes('duplicate') || message.includes('unique')) {
        return { allowed: false }
      }
      throw error
    }

    return { allowed: true }
  } catch (_error) {
    return { allowed: true }
  }
}
