import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = "gpt-4o-mini";

// ── 보안: 인메모리 Rate Limiter (분당 30회 / IP)
// Cold start 시 초기화되나, 기본적인 스팸 방지 역할
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_MIN = 30;
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

// ── 보안: 입력값 검증
const MAX_TEXT_LENGTH = 2000;

function validateInput(text: unknown): string | null {
  if (typeof text !== "string") return "텍스트 형식이 올바르지 않습니다";
  if (text.trim().length === 0) return "텍스트가 없습니다";
  if (text.length > MAX_TEXT_LENGTH) return `텍스트는 ${MAX_TEXT_LENGTH}자 이하여야 합니다`;
  return null; // 정상
}

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
    const body = await req.json();
    const {
      text,
      formalMode,
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct,
    } = body;

    // ── 보안: 입력값 검증
    const validationError = validateInput(text);
    if (validationError) {
      return json({ error: validationError }, 400);
    }

    const prompt = buildPrompt(
      text, formalMode, includePunct, includeDialect, formalLevel, formalIncludePunct
    );

    const result = await callGPT(prompt);
    return json({ result });
  } catch (e) {
    return json({ error: "서버 오류가 발생했습니다" }, 500); // 내부 오류 메시지 노출 방지
  }
});

function buildPrompt(
  text: string,
  formalMode: boolean,
  includePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean
): string {
  const noPunct = " 중요: 쉼표(,)와 마침표(.)는 절대로 추가·삭제·변경하지 마세요. 원문의 구두점을 그대로 유지하세요.";

  if (formalMode) {
    const punctNote = !formalIncludePunct ? noPunct : "";
    switch (formalLevel) {
      case "엄격 격식체":
        return `다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정하고, 격식체 존댓말(-습니다/-입니다 체)로 변환해주세요.${punctNote} 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      case "스마트 교정":
        return `다음 한국어 텍스트를 맞춤법을 교정하고, 전문적인 비즈니스 격식체로 자연스럽게 바꿔주세요.${punctNote} 구어체·감탄사·비격식 표현을 정중하고 명확한 비즈니스 표현으로 바꾸되 원래 의미는 유지하세요. 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      case "사내 메시지":
        return `다음 텍스트를 회사 내 동료 또는 상사에게 보내는 정중한 업무 메시지로 완전히 다시 작성해주세요.\n- 상황에 맞는 인사말로 시작\n- 감정적이거나 구어체 표현은 업무 중심 표현으로 변환\n- 핵심 내용과 의도는 반드시 유지\n- 전체 -습니다/-입니다 격식체 사용\n변환된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      case "고객 응대":
        return `다음 텍스트를 고객에게 보내는 따뜻하고 친절한 메시지로 완전히 다시 작성해주세요.\n- 상황에 맞는 인사말로 시작\n- 불편하거나 부정적인 내용은 공감하며 완곡하게 표현 (예: "불편하셨겠어요", "많이 기다리셨죠")\n- 고객 중심의 언어 사용 (고객님)\n- 딱딱한 공문서 느낌이 아닌 따뜻하고 진심 어린 톤\n- 핵심 내용과 의도는 반드시 유지\n- "감사합니다 / 좋은 하루 되세요" 등 마무리 인사 포함\n- 전체 -습니다/-입니다 격식체 사용\n변환된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      case "학부모 안내":
        return `다음 텍스트를 학부모 또는 외부 관계자에게 보내는 정중한 메시지로 완전히 다시 작성해주세요.\n- 인사말은 반드시 "어머님/아버님 안녕하세요" 또는 "학부모님 안녕하세요" 로 시작\n- "존경하는", "귀하", "귀하의" 같은 표현은 절대 사용 금지\n- 직접적이거나 단정적인 표현은 부드럽고 완곡하게 변환\n- 상대방 관련 표현은 존중하는 방식으로\n- 핵심 내용과 의도는 반드시 유지\n- "좋은 하루 되세요 / 감사합니다" 등 마무리 인사 포함\n- 전체 -습니다/-입니다 격식체 사용\n변환된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      case "소개팅":
        return `다음 텍스트를 소개팅 상대에게 보내는 자연스럽고 호감 가는 메시지로 다시 작성해주세요.\n- 비속어, 거친 표현, 취조식 표현은 부드럽게 변환\n- 자기 자랑보다 상대를 배려하는 방향으로\n- ㅋ, ㅎ, ㅠ 등 자음만 있는 표현 모두 제거\n- 이모티콘, 이모지 모두 제거\n- ... (말줄임표) 제거\n- ;; 등 키보드 이모티콘 제거\n- 갑작스러운 칭찬이나 고백 표현 자제\n- 차분하고 여유 있는 사람처럼 보이는 톤 유지\n- 진심 있고 따뜻하되 과하지 않게\n- 자연스러운 존댓말 사용 (너무 딱딱하지 않게)\n- "즐거운 시간이었습니다", "소중한 시간이었습니다" 같은 AI스러운 표현 금지\n- 실제 사람이 자연스럽게 쓸 법한 말투로 작성\n- 핵심 내용과 의도는 반드시 유지\n변환된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
      default:
        return `다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정하고, 자연스러운 존댓말(-요/-세요 체)로 변환해주세요.${punctNote} 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
    }
  }

  let base = "다음 한국어 텍스트의 맞춤법과 띄어쓰기를 교정해주세요.";
  if (!includePunct) base += noPunct;
  if (includeDialect) base += " 사투리 표현도 표준어로 교정해주세요.";
  return `${base} 교정된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;
}

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
