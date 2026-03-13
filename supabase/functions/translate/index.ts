import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = "gpt-4o-mini";

// ── 보안: 인메모리 Rate Limiter (분당 20회 / IP)
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_MIN = 20;
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) return true;
  entry.count++;
  return false;
}

// ── 보안: 허용된 언어 코드 화이트리스트
const ALLOWED_LANGS = new Set(["ko", "en", "zh", "ja"]);
const MAX_TEXT_LENGTH = 2000;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  // ── 보안: IP 기반 Rate Limit 체크
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }, 429);
  }

  // ── 보안: 요청 크기 제한 (10KB)
  const contentLength = parseInt(req.headers.get("content-length") ?? "0");
  if (contentLength > 10_000) {
    return json({ error: "요청 크기가 너무 큽니다" }, 413);
  }

  try {
    const { text, targetLang } = await req.json();

    // ── 보안: 입력값 검증
    if (typeof text !== "string" || text.trim().length === 0) {
      return json({ error: "텍스트가 없습니다" }, 400);
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return json({ error: `텍스트는 ${MAX_TEXT_LENGTH}자 이하여야 합니다` }, 400);
    }

    // ── 보안: 허용된 언어 코드만 처리 (화이트리스트)
    if (!ALLOWED_LANGS.has(targetLang)) {
      return json({ error: "지원하지 않는 언어입니다" }, 400);
    }

    const langName: Record<string, string> = {
      ko: "한국어", en: "영어", zh: "중국어(간체)", ja: "일본어",
    };
    const lang = langName[targetLang];
    const prompt = `다음 텍스트를 ${lang}로 번역해주세요. 번역된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;

    const result = await callGPT(prompt);
    return json({ result });
  } catch (e) {
    return json({ error: "서버 오류가 발생했습니다" }, 500); // 내부 오류 메시지 노출 방지
  }
});

async function callGPT(prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1000, // 보안: 응답 토큰 제한으로 비용 제어
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI 오류 (${res.status})`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
