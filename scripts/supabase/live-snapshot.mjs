#!/usr/bin/env node
// Records the live source of deployed Edge Functions in supabase/live-functions/<slug>/ and MANIFEST.json.
// Usage: node scripts/supabase/live-snapshot.mjs [slug ...]   (no slug = every deployed function)
import { api, downloadLive, writeSnapshot } from './lib.mjs'

const all = await api('/functions')
const wanted = process.argv.slice(2)
const targets = wanted.length ? all.filter((f) => wanted.includes(f.slug)) : all
for (const name of wanted) if (!all.some((f) => f.slug === name)) console.warn(`not deployed: ${name}`)

for (const fn of targets) {
  writeSnapshot(fn.slug, downloadLive(fn.slug), fn)
  console.log(`recorded ${fn.slug} v${fn.version}`)
}
