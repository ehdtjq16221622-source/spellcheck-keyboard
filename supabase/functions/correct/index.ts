import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = "gpt-4o-mini";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const {
      text,
      formalMode,
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct,
    } = await req.json();

    if (!text || text.trim().length === 0) {
      return json({ error: "텍스트가 없습니다" }, 400);
    }

    const prompt = buildPrompt(
      text, formalMode, includePunct, includeDialect, formalLevel, formalIncludePunct
    );

    const result = await callGPT(prompt);
    return json({ result });
  } catch (e) {
    return json({ error: e.message }, 500);
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
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI 오류 (${res.status}): ${err}`);
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
