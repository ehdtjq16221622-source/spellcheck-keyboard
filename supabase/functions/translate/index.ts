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
    const { text, targetLang } = await req.json();

    if (!text || text.trim().length === 0) {
      return json({ error: "텍스트가 없습니다" }, 400);
    }

    const langName: Record<string, string> = {
      ko: "한국어", en: "영어", zh: "중국어(간체)", ja: "일본어",
    };
    const lang = langName[targetLang] ?? targetLang;
    const prompt = `다음 텍스트를 ${lang}로 번역해주세요. 번역된 텍스트만 반환하고 설명은 추가하지 마세요.\n\n${text}`;

    const result = await callGPT(prompt);
    return json({ result });
  } catch (e) {
    return json({ error: e.message }, 500);
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
