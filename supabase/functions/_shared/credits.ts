import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const DAILY_FREE = 50
export const PLAN1_DAILY_CREDITS = 5000
export const PLAN2_DAILY_CREDITS = 10000
export const MONTHLY_SUBSCRIPTION_CREDITS = 5000
export const REWARDED_AD_CREDITS = 500

export type CreditSnapshot = {
  freeCredits: number
  paidCredits: number
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
  const row = await ensureCreditRow(supabase, deviceId)
  const snapshot = toSnapshot(row)
  if (snapshot.remaining < cost) {
    return { allowed: false, snapshot }
  }

  let remainingCost = cost
  const nextFree = Math.max(row.free_credits - remainingCost, 0)
  remainingCost = Math.max(remainingCost - row.free_credits, 0)
  const nextPaid = Math.max(row.paid_credits - remainingCost, 0)

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

export async function setMonthlySubscriptionCredits(
  supabase: SupabaseClient,
  deviceId: string,
  amount: number = MONTHLY_SUBSCRIPTION_CREDITS
): Promise<CreditSnapshot> {
  return addPaidCredits(supabase, deviceId, amount)
}
