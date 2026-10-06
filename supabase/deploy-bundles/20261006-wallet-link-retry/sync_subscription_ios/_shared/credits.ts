import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const INSTALL_BONUS = 500
export const PLAN1_MONTHLY_CREDITS = 4000
export const PLAN2_MONTHLY_CREDITS = 9000
export const PLAN3_MONTHLY_CREDITS = 30000
export const MONTHLY_SUBSCRIPTION_CREDITS = PLAN1_MONTHLY_CREDITS
export const REWARDED_AD_CREDITS = 200

const PLAN1_PRODUCT_ID = 'com.kingboard.app.monthly_basic'
const PLAN2_PRODUCT_ID = 'com.kingboard.app.monthly_premium'
const PLAN3_PRODUCT_ID = 'com.kingboard.app.monthly_pro'
const GOOGLE_PLAN1_PRODUCT_ID = 'kingboard_monthly_500'
const GOOGLE_PLAN2_PRODUCT_ID = 'kingboard_monthly_1000'

export type CreditSnapshot = {
  freeCredits: number
  paidCredits: number
  remaining: number
}

export type DeductedCredits = {
  free: number
  subscription: number
  paid: number
}

export type AIUsageResult = CreditSnapshot & {
  accepted: boolean
  alreadyProcessed: boolean
}

type CreditRow = {
  device_id: string
  free_credits: number
  paid_credits: number
  subscription_credits: number
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

function toSnapshot(row: Pick<CreditRow, 'free_credits' | 'paid_credits' | 'subscription_credits'>): CreditSnapshot {
  return {
    freeCredits: row.free_credits,
    paidCredits: row.paid_credits + row.subscription_credits,
    remaining: row.free_credits + row.paid_credits + row.subscription_credits,
  }
}

export function subscriptionCreditsForProduct(productId: string): number {
  if (productId === PLAN3_PRODUCT_ID) return PLAN3_MONTHLY_CREDITS
  if (productId === PLAN2_PRODUCT_ID) return PLAN2_MONTHLY_CREDITS
  if (productId === PLAN1_PRODUCT_ID) return PLAN1_MONTHLY_CREDITS
  return MONTHLY_SUBSCRIPTION_CREDITS
}

export function googleSubscriptionCreditsForProduct(productId: string): number {
  if (productId === GOOGLE_PLAN2_PRODUCT_ID) return PLAN2_MONTHLY_CREDITS
  if (productId === GOOGLE_PLAN1_PRODUCT_ID) return PLAN1_MONTHLY_CREDITS
  return MONTHLY_SUBSCRIPTION_CREDITS
}

async function ensureCreditRow(
  supabase: SupabaseClient,
  deviceId: string
): Promise<CreditRow> {
  const today = todayInKst()
  const { data, error } = await supabase
    .from('device_credits')
    .select('device_id, free_credits, paid_credits, subscription_credits, last_reset_date')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    const row: CreditRow = {
      device_id: deviceId,
      // A missing row is not proof that this wallet is eligible for an
      // installation bonus. Trusted registration/claim flows own that grant.
      free_credits: 0,
      paid_credits: 0,
      subscription_credits: 0,
      last_reset_date: today,
    }
    const columns = 'device_id, free_credits, paid_credits, subscription_credits, last_reset_date'
    const { data: inserted, error: insertError } = await supabase
      .from('device_credits')
      .insert(row)
      .select(columns)
      .maybeSingle()
    if (!insertError && inserted) return inserted as CreditRow
    if (insertError?.code !== '23505') {
      if (insertError) throw insertError
      throw new Error('Credit wallet insert returned no row.')
    }

    const { data: concurrentInsert, error: readError } = await supabase
      .from('device_credits')
      .select(columns)
      .eq('device_id', deviceId)
      .maybeSingle()
    if (readError) throw readError
    if (!concurrentInsert) throw insertError
    return concurrentInsert as CreditRow
  }

  return data as CreditRow
}

export async function getCredits(
  supabase: SupabaseClient,
  deviceId: string
): Promise<CreditSnapshot> {
  return toSnapshot(await ensureCreditRow(supabase, deviceId))
}

export async function consumeAIUsage(
  supabase: SupabaseClient,
  deviceId: string,
  requestId: string,
  kind: 'correct' | 'formal' | 'translate'
): Promise<AIUsageResult> {
  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_device_id: deviceId,
    p_request_id: requestId,
    p_kind: kind,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Credit usage response was empty.')
  const freeCredits = Number(row.free_credits_remaining ?? 0)
  const paidCredits = Number(row.paid_credits_remaining ?? 0)
  return {
    accepted: row.accepted === true,
    alreadyProcessed: row.already_processed === true,
    freeCredits,
    paidCredits,
    remaining: freeCredits + paidCredits,
  }
}

export async function refundAIUsage(
  supabase: SupabaseClient,
  deviceId: string,
  requestId: string
): Promise<CreditSnapshot> {
  const { data, error } = await supabase.rpc('refund_ai_credits', {
    p_device_id: deviceId,
    p_request_id: requestId,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('AI credit refund response was empty.')
  const freeCredits = Number(row.free_credits_remaining ?? 0)
  const paidCredits = Number(row.paid_credits_remaining ?? 0)
  return {
    freeCredits,
    paidCredits,
    remaining: freeCredits + paidCredits,
  }
}

export async function checkAndDeduct(
  supabase: SupabaseClient,
  deviceId: string,
  cost: number
): Promise<{ allowed: boolean; snapshot: CreditSnapshot; deducted: DeductedCredits }> {
  const row = await ensureCreditRow(supabase, deviceId)
  const snapshot = toSnapshot(row)
  if (snapshot.remaining < cost) {
    return { allowed: false, snapshot, deducted: { free: 0, subscription: 0, paid: 0 } }
  }

  const deductedFree = Math.min(row.free_credits, cost)
  const deductedSubscription = Math.min(row.subscription_credits, cost - deductedFree)
  const deductedPaid = cost - deductedFree - deductedSubscription
  const nextFree = row.free_credits - deductedFree
  const nextSubscription = row.subscription_credits - deductedSubscription
  const nextPaid = row.paid_credits - deductedPaid

  const { error } = await supabase
    .from('device_credits')
    .update({
      free_credits: nextFree,
      subscription_credits: nextSubscription,
      paid_credits: nextPaid,
      updated_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId)
  if (error) throw error

  return {
    allowed: true,
    snapshot: {
      freeCredits: nextFree,
      paidCredits: nextPaid + nextSubscription,
      remaining: nextFree + nextPaid + nextSubscription,
    },
    deducted: {
      free: deductedFree,
      subscription: deductedSubscription,
      paid: deductedPaid,
    },
  }
}

export async function refundDeductedCredits(
  supabase: SupabaseClient,
  deviceId: string,
  deducted: DeductedCredits
): Promise<CreditSnapshot> {
  if (deducted.free <= 0 && deducted.subscription <= 0 && deducted.paid <= 0) {
    return getCredits(supabase, deviceId)
  }

  const row = await ensureCreditRow(supabase, deviceId)
  const nextFree = row.free_credits + deducted.free
  const nextSubscription = row.subscription_credits + deducted.subscription
  const nextPaid = row.paid_credits + deducted.paid

  const { error } = await supabase
    .from('device_credits')
    .update({
      free_credits: nextFree,
      subscription_credits: nextSubscription,
      paid_credits: nextPaid,
      updated_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId)
  if (error) throw error

  return {
    freeCredits: nextFree,
    paidCredits: nextPaid + nextSubscription,
    remaining: nextFree + nextPaid + nextSubscription,
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
    paidCredits: nextPaid + row.subscription_credits,
    remaining: row.free_credits + nextPaid + row.subscription_credits,
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
  if (!idempotencyKey) throw new Error('A subscription cycle key is required.')
  const { data, error } = await supabase.rpc('reset_subscription_credits', {
    p_device_id: deviceId,
    p_amount: amount,
    p_cycle_key: idempotencyKey,
    p_metadata: metadata,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Subscription credit response was empty.')
  const freeCredits = Number(row.free_credits_remaining ?? 0)
  const paidCredits = Number(row.paid_credits_remaining ?? 0)
  return {
    applied: row.applied === true,
    snapshot: {
      freeCredits,
      paidCredits,
      remaining: freeCredits + paidCredits,
    },
  }
}

export async function applyUsageEventOnce(
  supabase: SupabaseClient,
  deviceId: string,
  eventId: string,
  requestedFree: number,
  requestedPaid: number,
  metadata: Record<string, unknown> = {}
): Promise<{ snapshot: CreditSnapshot; applied: boolean }> {
  const { data, error } = await supabase.rpc('apply_client_usage_once', {
    p_device_id: deviceId,
    p_event_id: eventId,
    p_requested_free: requestedFree,
    p_requested_paid: requestedPaid,
    p_metadata: metadata,
  })
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Usage synchronization response was empty.')
  const freeCredits = Number(row.free_credits_remaining ?? 0)
  const paidCredits = Number(row.paid_credits_remaining ?? 0)
  return {
    snapshot: {
      freeCredits,
      paidCredits,
      remaining: Number(row.credits_remaining ?? freeCredits + paidCredits),
    },
    applied: row.applied === true,
  }
}
