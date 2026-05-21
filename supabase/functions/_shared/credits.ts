import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const DAILY_FREE = 100
export const PLAN1_MONTHLY_CREDITS = 4000
export const PLAN2_MONTHLY_CREDITS = 9000
export const MONTHLY_SUBSCRIPTION_CREDITS = PLAN1_MONTHLY_CREDITS
export const REWARDED_AD_CREDITS = 200

const PLAN1_PRODUCT_ID = 'com.kingboard.app.monthly_basic'
const PLAN2_PRODUCT_ID = 'com.kingboard.app.monthly_premium'

export type CreditSnapshot = {
  freeCredits: number
  paidCredits: number
  remaining: number
}

export type DeductedCredits = {
  free: number
  paid: number
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

export function subscriptionCreditsForProduct(productId: string): number {
  if (productId === PLAN2_PRODUCT_ID) return PLAN2_MONTHLY_CREDITS
  if (productId === PLAN1_PRODUCT_ID) return PLAN1_MONTHLY_CREDITS
  return MONTHLY_SUBSCRIPTION_CREDITS
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

  return data as CreditRow
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
): Promise<{ allowed: boolean; snapshot: CreditSnapshot; deducted: DeductedCredits }> {
  const row = await ensureCreditRow(supabase, deviceId)
  const snapshot = toSnapshot(row)
  if (snapshot.remaining < cost) {
    return { allowed: false, snapshot, deducted: { free: 0, paid: 0 } }
  }

  const deductedFree = Math.min(row.free_credits, cost)
  const deductedPaid = cost - deductedFree
  const nextFree = row.free_credits - deductedFree
  const nextPaid = row.paid_credits - deductedPaid

  const { error } = await supabase
    .from('device_credits')
    .update({
      free_credits: nextFree,
      paid_credits: nextPaid,
      updated_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId)
  if (error) throw error

  return {
    allowed: true,
    snapshot: {
      freeCredits: nextFree,
      paidCredits: nextPaid,
      remaining: nextFree + nextPaid,
    },
    deducted: {
      free: deductedFree,
      paid: deductedPaid,
    },
  }
}

export async function refundDeductedCredits(
  supabase: SupabaseClient,
  deviceId: string,
  deducted: DeductedCredits
): Promise<CreditSnapshot> {
  if (deducted.free <= 0 && deducted.paid <= 0) {
    return getCredits(supabase, deviceId)
  }

  const row = await ensureCreditRow(supabase, deviceId)
  const nextFree = row.free_credits + deducted.free
  const nextPaid = row.paid_credits + deducted.paid

  const { error } = await supabase
    .from('device_credits')
    .update({
      free_credits: nextFree,
      paid_credits: nextPaid,
      updated_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId)
  if (error) throw error

  return {
    freeCredits: nextFree,
    paidCredits: nextPaid,
    remaining: nextFree + nextPaid,
  }
}

export async function addPaidCredits(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number
): Promise<CreditSnapshot> {
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

export async function addPaidCreditsOnce(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number,
  transactionType: string,
  idempotencyKey: string,
  metadata: Record<string, unknown> = {}
): Promise<{ snapshot: CreditSnapshot; applied: boolean }> {
  const transaction = {
    device_id: deviceId,
    transaction_type: transactionType,
    idempotency_key: idempotencyKey,
    free_delta: 0,
    paid_delta: amount,
    metadata,
  }

  const { error: insertError } = await supabase
    .from('credit_transactions')
    .insert(transaction)

  if (insertError) {
    if (insertError.code === '23505') {
      return { snapshot: await getCredits(supabase, deviceId), applied: false }
    }
    throw insertError
  }

  return {
    snapshot: await addPaidCredits(supabase, deviceId, amount),
    applied: true,
  }
}

export async function setMonthlySubscriptionCredits(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number = MONTHLY_SUBSCRIPTION_CREDITS,
  idempotencyKey?: string,
  metadata: Record<string, unknown> = {}
): Promise<{ snapshot: CreditSnapshot; applied: boolean }> {
  if (!idempotencyKey) {
    return { snapshot: await addPaidCredits(supabase, deviceId, amount), applied: true }
  }

  return addPaidCreditsOnce(
    supabase,
    deviceId,
    amount,
    'subscription_monthly_grant',
    idempotencyKey,
    metadata
  )
}
