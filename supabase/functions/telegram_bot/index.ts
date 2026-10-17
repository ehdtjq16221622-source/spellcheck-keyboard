import { sendTelegram } from "./_shared/telegram.ts";

const COMMANDS = [
  { command: "summary", description: "오늘 전체 요약" },
  { command: "subs", description: "구독자/플랜 현황" },
  { command: "lowbalance", description: "저잔액 전환 흐름" },
  { command: "ads", description: "광고 보상 현황" },
  { command: "referrals", description: "친구 초대 현황" },
  { command: "cost", description: "AI 사용량과 예상 원가" },
  { command: "funnel", description: "결제 전환 관찰 포인트" },
];

function internalHeaders(): HeadersInit {
  const secret = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? Deno.env.get("CRON_SECRET");
  return secret ? { "x-internal-secret": secret } : {};
}

async function triggerDigest(view = "overview") {
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/daily_digest?range=today&view=${view}`, {
    method: "POST",
    headers: internalHeaders(),
  });
}

function validTelegramSecret(req: Request): boolean {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return true;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.searchParams.get("setup") === "1") {
    const setupSecret = Deno.env.get("TELEGRAM_SETUP_SECRET");
    if (setupSecret && url.searchParams.get("secret") !== setupSecret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram_bot`;
    const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
    const set = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: hookUrl,
        allowed_updates: ["message"],
        secret_token: webhookSecret || undefined,
      }),
    }).then((r) => r.json());
    const commands = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: COMMANDS }),
    }).then((r) => r.json());
    return new Response(JSON.stringify({ setWebhook: set, setMyCommands: commands }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (!validTelegramSecret(req)) return new Response("ok");

    const update = await req.json().catch(() => ({}));
    const msg = update?.message;
    const text: string = (msg?.text ?? "").trim();
    const chatId = msg?.chat?.id;
    const owner = Deno.env.get("TELEGRAM_CHAT_ID");

    if (!chatId || String(chatId) !== String(owner)) return new Response("ok");

    const cmd = text.split(/\s+/)[0].replace(/@.*$/, "");
    const map: Record<string, string> = {
      "/요약": "overview",
      "/현황": "overview",
      "/summary": "overview",
      "/구독": "subscriptions",
      "/subs": "subscriptions",
      "/subscriptions": "subscriptions",
      "/저잔액": "low_balance",
      "/low": "low_balance",
      "/lowbalance": "low_balance",
      "/low_balance": "low_balance",
      "/광고": "ads",
      "/ads": "ads",
      "/초대": "referrals",
      "/invite": "referrals",
      "/referrals": "referrals",
      "/비용": "cost",
      "/cost": "cost",
      "/퍼널": "funnel",
      "/funnel": "funnel",
    };

    if (cmd === "/start") {
      await sendTelegram(
        "킹보드 봇\n\n/요약 /구독 /저잔액 /광고 /초대 /비용 /퍼널\n매일 낮 12시에는 자동 요약이 발송됩니다.",
      );
      return new Response("ok");
    }

    const view = map[cmd];
    if (view) {
      // Answer Telegram right away. The digest can take 1-2 minutes, and a slow
      // webhook reply makes Telegram resend the same command, repeating summaries.
      const task = triggerDigest(view).catch(() => {});
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task);
      // Make sure the digest request is dispatched before replying. The digest
      // keeps running and posts the summary itself (the pg_net cron also stops
      // waiting after a few seconds), while a reply within seconds stops
      // Telegram from resending the same command.
      await Promise.race([task, new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
    return new Response("ok");
  } catch (_) {
    return new Response("ok");
  }
});