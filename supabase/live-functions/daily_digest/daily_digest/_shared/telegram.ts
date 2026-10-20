// Shared Telegram sender for admin notifications (daily digest, alerts, etc.).
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets.
// Fails soft: logs a warning if not configured so callers never crash on a
// missing token.

export async function sendTelegram(
  text: string,
  opts: { parseMode?: 'HTML' | 'MarkdownV2'; chatId?: string } = {}
): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const chatId = opts.chatId ?? Deno.env.get('TELEGRAM_CHAT_ID')
  if (!token || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; skipping send')
    return false
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

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`[telegram] send failed: ${res.status} ${body}`)
  }
  return true
}
