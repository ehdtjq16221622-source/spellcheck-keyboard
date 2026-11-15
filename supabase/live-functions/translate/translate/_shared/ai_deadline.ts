export class AIRequestTimeout extends Error {
  constructor() { super('AI request deadline exceeded'); this.name = 'AIRequestTimeout' }
}

export class AIRequestDeadline {
  readonly controller = new AbortController()
  readonly timeoutMs: number
  constructor(timeoutMs = 10_000) { this.timeoutMs = timeoutMs }
  get signal(): AbortSignal { return this.controller.signal }
  check() { if (this.signal.aborted) throw new AIRequestTimeout() }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.controller.abort()
        reject(new AIRequestTimeout())
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(operation), expired])
    } finally { clearTimeout(timer) }
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    this.check()
    const response = await fetch(url, { ...init, signal: this.signal })
    this.check()
    return response
  }

  async sleep(ms: number): Promise<void> {
    this.check()
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => { clearTimeout(timer); reject(new AIRequestTimeout()) }
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', cancelled)
        resolve()
      }, ms)
      this.signal.addEventListener('abort', cancelled, { once: true })
    })
  }
}

// No text, wallet ID or token is recorded. Ledger idempotency_key uses this same request ID.
// deno-lint-ignore no-explicit-any
export function recordSlowAIRequest(db: any, kind: 'correct' | 'translate', durationMs: number,
                                   outcome: 'ok' | 'error', requestId: string, diagnosticId: string) {
  if (durationMs < 10_000) return
  requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ? requestId : ''
  console.log(JSON.stringify({ event: 'ai_request_finished', kind, request_id: requestId || null,
    diagnostic_id: diagnosticId, duration_ms: durationMs, outcome }))
  const task = Promise.resolve().then(() => db.from('ai_slow_requests').insert({
    kind, duration_ms: durationMs, outcome, request_id: requestId || null, diagnostic_id: diagnosticId,
  })).then(({ error }: { error: unknown }) => {
    if (error) console.warn(JSON.stringify({ event: 'ai_slow_log_failed', request_id: requestId, diagnostic_id: diagnosticId }))
  }).catch(() => console.warn(JSON.stringify({ event: 'ai_slow_log_failed', request_id: requestId, diagnostic_id: diagnosticId })))
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) runtime.waitUntil(task)
}
