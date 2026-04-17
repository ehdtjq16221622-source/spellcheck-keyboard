import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export class UserFacingError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function requireTextDeviceId(deviceId: unknown): string {
  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new UserFacingError('기기 정보를 확인할 수 없습니다.', 400)
  }
  return deviceId.trim()
}

export function requireNonEmptyText(text: unknown, fieldLabel: string): string {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new UserFacingError(`${fieldLabel}을(를) 입력해 주세요.`, 400)
  }
  return text.trim()
}

export function assertMeaningfulText(text: string, minLength = 2): void {
  const normalized = text.replace(/\s+/g, '')
  if (normalized.length < minLength) {
    throw new UserFacingError('입력 길이가 너무 짧아요. 조금 더 길게 입력해 주세요.', 400)
  }
}

type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: string
}

export async function enforceRateLimit(
  supabase: SupabaseClient,
  scope: string,
  deviceId: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const bucketKey = `${scope}:${deviceId}`
  const now = new Date()
  const resetAt = new Date(now.getTime() + windowMs)

  try {
    const { data, error } = await supabase
      .from('request_rate_limits')
      .select('bucket_key, request_count, window_started_at')
      .eq('bucket_key', bucketKey)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      const { error: insertError } = await supabase.from('request_rate_limits').insert({
        bucket_key: bucketKey,
        request_count: 1,
        window_started_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      if (insertError) throw insertError
      return { allowed: true, remaining: Math.max(limit - 1, 0), resetAt: resetAt.toISOString() }
    }

    const windowStartedAt = new Date(data.window_started_at)
    const windowExpired = now.getTime() - windowStartedAt.getTime() >= windowMs

    if (windowExpired) {
      const { error: updateError } = await supabase
        .from('request_rate_limits')
        .update({
          request_count: 1,
          window_started_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('bucket_key', bucketKey)
      if (updateError) throw updateError
      return { allowed: true, remaining: Math.max(limit - 1, 0), resetAt: resetAt.toISOString() }
    }

    if (data.request_count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(windowStartedAt.getTime() + windowMs).toISOString(),
      }
    }

    const nextCount = data.request_count + 1
    const { error: updateError } = await supabase
      .from('request_rate_limits')
      .update({
        request_count: nextCount,
        updated_at: now.toISOString(),
      })
      .eq('bucket_key', bucketKey)

    if (updateError) throw updateError

    return {
      allowed: true,
      remaining: Math.max(limit - nextCount, 0),
      resetAt: new Date(windowStartedAt.getTime() + windowMs).toISOString(),
    }
  } catch (_error) {
    // If the table isn't applied yet, avoid breaking user traffic.
    return { allowed: true, remaining: limit, resetAt: resetAt.toISOString() }
  }
}

export async function fetchWithTimeoutRetry(
  input: string,
  init: RequestInit,
  timeoutMs = 8000,
  retries = 1,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs)

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok && response.status >= 500 && attempt < retries) {
        lastError = new Error(`OpenAI ${response.status}`)
        continue
      }

      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt >= retries) break
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
