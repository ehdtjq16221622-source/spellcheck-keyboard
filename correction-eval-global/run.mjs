// English / Japanese correction eval against the real model, with the exact prompts and generation
// settings the Edge Function uses. Usage: node correction-eval-global/run.mjs  (needs GEMINI_API_KEY)
// Writes report.json next to this file. Never sends user data: the cases are written for the eval.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const here = new URL('./', import.meta.url);
const prompts = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(
  readFileSync(new URL('../supabase/functions/correct/language_prompts.ts', here), 'utf8')))}`);
const { proofing, tone } = JSON.parse(readFileSync(new URL('cases.json', here), 'utf8'));
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY is not set');

async function gemini(system, text, { thinking, temperature, maxOutputTokens }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingLevel: thinking } } }),
    });
    const data = await res.json();
    if (res.ok) {
      return (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
    }
    if (res.status !== 429 && res.status < 500) throw new Error(data.error?.message ?? res.status);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error('model unavailable');
}

const results = [];
for (const c of proofing) {
  const system = prompts.buildForeignProofingPrompt(c.lang, false);
  let out = await gemini(system, c.text, { thinking: 'low', temperature: 0.3, maxOutputTokens: 1000 });
  const guarded = prompts.hasSuspiciousForeignDeletion(c.text, out, c.lang);
  if (guarded) out = c.text;
  const missing = c.must.filter((s) => !out.includes(s));
  const lost = c.keep.filter((s) => !out.includes(s));
  const changedWhenClean = c.unchanged && out !== c.text;
  results.push({ kind: 'proofing', id: c.id, lang: c.lang, input: c.text, output: out, guarded,
    pass: missing.length === 0 && lost.length === 0 && !changedWhenClean, missing, lost, changedWhenClean });
}
for (const c of tone) {
  const system = prompts.buildForeignTonePrompt(c.lang, c.level, true);
  const out = await gemini(system, c.text, { thinking: 'medium', temperature: 0.3, maxOutputTokens: 4096 });
  const missing = c.expect.filter((re) => !new RegExp(re, 'm').test(out));
  const unwanted = c.avoid.filter((re) => new RegExp(re, 'm').test(out));
  const wrongLanguage = c.lang === 'en' ? /[぀-ヿ가-힣]/.test(out) : /[가-힣]/.test(out) || !/[぀-ヿ一-鿿]/.test(out);
  results.push({ kind: 'tone', id: c.id, lang: c.lang, level: c.level, input: c.text, output: out,
    pass: missing.length === 0 && unwanted.length === 0 && !wrongLanguage, missing, unwanted, wrongLanguage });
}

const summary = {};
for (const r of results) {
  const k = `${r.kind}:${r.lang}`;
  summary[k] ??= { pass: 0, total: 0 };
  summary[k].total++;
  if (r.pass) summary[k].pass++;
}
writeFileSync(new URL('report.json', here), JSON.stringify({ model: 'gemini-3.1-flash-lite', summary, results }, null, 2));
console.log(JSON.stringify(summary));
for (const r of results.filter((x) => !x.pass)) {
  console.log(`FAIL ${r.id}: ${r.input}  =>  ${r.output}  ${JSON.stringify({ missing: r.missing, lost: r.lost, unwanted: r.unwanted, wrongLanguage: r.wrongLanguage, changedWhenClean: r.changedWhenClean })}`);
}
