// English / Japanese correction eval against the real model, with the exact prompts and generation
// settings the Edge Function uses. Usage: node correction-eval-global/run.mjs  (needs GEMINI_API_KEY)
//   RUNS=3     run every case this many times (the model is not deterministic); a case passes only
//              when every run passes
//   OUT=name   report file name (default report.json)
// Writes the report next to this file. Never sends user data: the cases are written for the eval.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const here = new URL('./', import.meta.url);
const prompts = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(
  readFileSync(new URL('../supabase/functions/correct/language_prompts.ts', here), 'utf8')))}`);
//   CASES=file case file (default cases.json). A case with "app" instead of "lang" is routed the way
//              the server routes it: resolveCorrectionLanguage(text, app). "mixed": true allows the
//              other language's words (names, places) to stay in the output.
const { proofing: rawProofing, tone: rawTone } = JSON.parse(readFileSync(new URL(process.env.CASES ?? 'cases.json', here), 'utf8'));
const route = (c) => (c.lang ? c : { ...c, lang: prompts.resolveCorrectionLanguage(c.text, c.app) });
const proofing = rawProofing.map(route);
const only = (process.env.LEVELS ?? '').split(',').filter(Boolean); // LEVELS=격식체,스마트 교정 limits the tone cases
const tone = rawTone.filter((c) => only.length === 0 || only.includes(c.level)).map(route);
for (const c of [...proofing, ...tone]) {
  if (c.lang !== 'en' && c.lang !== 'ja') throw new Error(`${c.id} routes to ${c.lang}; this eval covers en/ja prompts only`);
  if (c.expectLang && c.expectLang !== c.lang) throw new Error(`${c.id} routes to ${c.lang}, expected ${c.expectLang}`);
}
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY is not set');
const RUNS = Math.max(1, Number(process.env.RUNS ?? 1));

async function gemini(system, text, { thinking, temperature, maxOutputTokens }) {
  for (let attempt = 0; attempt < 4; attempt++) {
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

async function proofOnce(c) {
  const system = prompts.buildForeignProofingPrompt(c.lang, false);
  let out = prompts.unwrapForeignResult(
    await gemini(system, prompts.wrapForeignSource(c.text), { thinking: 'low', temperature: 0.3, maxOutputTokens: 1000 }));
  out = prompts.keepForeignEnding(c.text, out, c.lang);
  const guarded = prompts.isUnfaithfulForeignProofing(c.text, out, c.lang);
  if (guarded) out = c.text;
  const missing = c.must.filter((s) => !out.includes(s));
  const lost = c.keep.filter((s) => !out.includes(s));
  const unwanted = (c.forbid ?? []).filter((s) => out.includes(s));
  const changedWhenClean = Boolean(c.unchanged) && out !== c.text;
  return { output: out, guarded, missing, lost, unwanted, changedWhenClean,
    pass: missing.length === 0 && lost.length === 0 && unwanted.length === 0 && !changedWhenClean };
}

async function toneOnce(c) {
  const system = prompts.buildForeignTonePrompt(c.lang, c.level, true);
  const out = prompts.unwrapForeignResult(
    await gemini(system, prompts.wrapForeignSource(c.text), { thinking: 'medium', temperature: 0.3, maxOutputTokens: 4096 }));
  const missing = c.expect.filter((re) => !new RegExp(re, 'm').test(out));
  const unwanted = c.avoid.filter((re) => new RegExp(re, 'm').test(out));
  const wrongLanguage = c.mixed
    ? (c.lang === 'en' ? !/[A-Za-z]{3}/.test(out) : !/[぀-ヿ]/.test(out))
    : c.lang === 'en' ? /[぀-ヿ가-힣]/.test(out) : /[가-힣]/.test(out) || !/[぀-ヿ一-鿿]/.test(out);
  return { output: out, missing, unwanted, wrongLanguage, pass: missing.length === 0 && unwanted.length === 0 && !wrongLanguage };
}

async function runCase(kind, c) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await (kind === 'proofing' ? proofOnce(c) : toneOnce(c)));
  return { kind, id: c.id, lang: c.lang, ...(c.level ? { level: c.level } : {}), input: c.text,
    pass: runs.every((r) => r.pass), passes: runs.filter((r) => r.pass).length, runs };
}

// A few cases at a time keeps the run short without tripping rate limits.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const results = await pool([...proofing.map((c) => ['proofing', c]), ...tone.map((c) => ['tone', c])], 6,
  ([kind, c]) => runCase(kind, c));

const summary = {};
for (const r of results) {
  const k = `${r.kind}:${r.lang}`;
  summary[k] ??= { pass: 0, total: 0 };
  summary[k].total++;
  if (r.pass) summary[k].pass++;
}
const failures = results.filter((r) => !r.pass).map((r) => ({ id: r.id, level: r.level, input: r.input, passes: `${r.passes}/${RUNS}`,
  bad: r.runs.filter((x) => !x.pass).map((x) => ({ output: x.output, missing: x.missing, lost: x.lost, unwanted: x.unwanted,
    changedWhenClean: x.changedWhenClean, wrongLanguage: x.wrongLanguage })) }));
writeFileSync(new URL(process.env.OUT ?? 'report.json', here),
  JSON.stringify({ model: 'gemini-3.1-flash-lite', runsPerCase: RUNS, summary, failures, results }, null, 2));
console.log(JSON.stringify(summary), 'failed:', failures.map((f) => f.id).join(' '));
