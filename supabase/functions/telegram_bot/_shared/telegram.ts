// Shared Telegram sender for admin notifications.
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets.

type TelegramOptions = {
  parseMode?: "HTML" | "MarkdownV2";
  chatId?: string;
  supabase?: any;
  alertType?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function reserveAlert(opts: TelegramOptions, text: string): Promise<boolean> {
  if (!opts.supabase || !opts.alertType || !opts.idempotencyKey) return true;

  const { error } = await opts.supabase.from("telegram_alert_logs").insert({
    alert_type: opts.alertType,
    idempotency_key: opts.idempotencyKey,
    payload_hash: await sha256(text),
    metadata: opts.metadata ?? {},
  });

  if (!error) return true;
  if (String(error.code) === "23505" || String(error.message ?? "").includes("duplicate")) {
    console.log("[telegram] duplicate alert skipped", opts.alertType, opts.idempotencyKey);
    return false;
  }
  throw error;
}

export async function sendTelegram(text: string, opts: TelegramOptions = {}): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = opts.chatId ?? Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; skipping send");
    return false;
  }

  const shouldSend = await reserveAlert(opts, text);
  if (!shouldSend) return false;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode ?? "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[telegram] send failed: ${res.status} ${body}`);
  }
  return true;
}