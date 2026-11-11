// Shared Telegram sender for admin notifications (daily digest, alerts, etc.).

type TelegramOptions = {
  parseMode?: 'HTML' | 'MarkdownV2'
  chatId?: string
  supabase?: any
  alertType?: string
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

export async function sendTelegram(
  text: string,
  opts: TelegramOptions = {},
): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const chatId = opts.chatId ?? Deno.env.get('TELEGRAM_CHAT_ID')
  if (!token || !chatId) {
    console.warn('[telegram] required credentials are unavailable')
    return false
  }

  const hasDeliveryKey = opts.supabase && opts.alertType && opts.idempotencyKey
  if (hasDeliveryKey) {
    const { data, error } = await opts.supabase
      .from('telegram_alert_logs')
      .select('delivery_status')
      .eq('alert_type', opts.alertType)
      .eq('idempotency_key', opts.idempotencyKey)
      .maybeSingle()
    if (error) console.warn('[telegram] delivery lookup failed; sending anyway')
    else if (data?.delivery_status === 'delivered') return true
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? 'HTML',
      disable_web_page_preview: true,
    }),
  })

  const result = await res.json().catch(() => null) as { ok?: unknown } | null
  if (!res.ok || result?.ok !== true) {
    console.warn(`[telegram] send failed with HTTP ${res.status}`)
    throw new Error('telegram_delivery_failed')
  }

  if (hasDeliveryKey) {
    const row = {
      alert_type: opts.alertType,
      idempotency_key: opts.idempotencyKey,
      metadata: opts.metadata ?? {},
      delivery_status: 'delivered',
      sent_at: new Date().toISOString(),
    }
    const { error } = await opts.supabase
      .from('telegram_alert_logs')
      .upsert(row, { onConflict: 'alert_type,idempotency_key' })
    if (error) console.warn('[telegram] delivery record could not be saved after send')
  }
  return true
}
