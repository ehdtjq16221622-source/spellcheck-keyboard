#!/usr/bin/env node
// Compares what is live with (1) the recorded snapshot and (2) the source tree.
// Usage: node scripts/supabase/check-live.mjs [slug ...]
// Exit 1 when live differs from the recorded snapshot (someone deployed without recording it).
import path from 'node:path'
import { api, compare, downloadLive, FUNCTIONS_DIR, LIVE_DIR, readManifest, readTree, sourceFiles } from './lib.mjs'

const all = await api('/functions')
const wanted = process.argv.slice(2)
const targets = wanted.length ? all.filter((f) => wanted.includes(f.slug)) : all
const manifest = readManifest()
const sourceTree = readTree(FUNCTIONS_DIR)
let unrecorded = 0
let treeDiffers = 0

for (const fn of targets) {
  const live = readTree(downloadLive(fn.slug))
  const recorded = readTree(path.join(LIVE_DIR, fn.slug))
  const snapshotDiff = compare(recorded, live)
  const versionNote = manifest.functions[fn.slug]?.version === fn.version ? '' : ` (recorded v${manifest.functions[fn.slug]?.version ?? '-'})`
  const tree = Object.fromEntries(sourceFiles(fn.slug).map((file) => [file, sourceTree[file]]))
  const treeDiff = Object.keys(tree).length ? compare(tree, live) : ['not in supabase/functions']
  if (snapshotDiff.length) unrecorded += 1
  if (treeDiff.length) treeDiffers += 1
  const state = snapshotDiff.length ? 'UNRECORDED DEPLOY' : 'recorded'
  console.log(`${fn.slug.padEnd(38)} v${fn.version}${versionNote}  ${state}  |  source tree ${treeDiff.length ? 'differs' : 'matches'}`)
  for (const line of snapshotDiff) console.log(`    live vs snapshot: ${line}`)
  if (wanted.length) for (const line of treeDiff) console.log(`    live vs tree: ${line}`)
}
console.log(`\n${targets.length} functions, ${unrecorded} unrecorded deploys, ${treeDiffers} where the source tree differs from live.`)
process.exitCode = unrecorded ? 1 : 0
