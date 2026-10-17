#!/usr/bin/env node
// The only way to deploy an Edge Function from this repo.
// Usage: node scripts/supabase/deploy-function.mjs <slug> [--yes]
//  1. refuses when files the function uses have uncommitted changes
//  2. shows what will change compared with what is live; needs --yes to go on
//  3. deploys from supabase/functions with the live verify_jwt setting
//  4. downloads the result and checks it equals the source files
//  5. records the new live snapshot and appends supabase/DEPLOYS.md
import fs from 'node:fs'
import { accessToken, api, compare, DEPLOY_LOG, downloadLive, FUNCTIONS_DIR, projectRef, readTree, REPO, run, sourceFiles, writeSnapshot } from './lib.mjs'

const slug = process.argv[2]
const confirmed = process.argv.includes('--yes')
if (!slug || slug.startsWith('-')) {
  console.error('usage: node scripts/supabase/deploy-function.mjs <slug> [--yes]')
  process.exit(2)
}

const files = sourceFiles(slug)
if (!files.length) {
  console.error(`supabase/functions/${slug} does not exist`)
  process.exit(2)
}

// 1. Only committed code is deployed.
const dirty = run('git', ['status', '--porcelain', '--', ...files.map((f) => `supabase/functions/${f}`)], { cwd: REPO }).stdout.trim()
if (dirty) {
  console.error(`Uncommitted changes in files ${slug} uses. Commit them first:\n${dirty}`)
  process.exit(1)
}
const commit = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).stdout.trim()

await main()

async function main() {
// 2. What changes compared with live.
const all = await api('/functions')
const current = all.find((f) => f.slug === slug)
const tree = readTree(FUNCTIONS_DIR)
const source = Object.fromEntries(files.map((file) => [file, tree[file]]))
const before = current ? readTree(downloadLive(slug)) : {}
const changes = compare(before, source).filter((line) => !line.startsWith('only-left'))
console.log(current ? `${slug} is live as v${current.version} (verify_jwt=${current.verify_jwt}).` : `${slug} is not deployed yet.`)
console.log(changes.length ? `Files that change on deploy:\n  ${changes.join('\n  ')}` : 'No file changes compared with live.')
if (!confirmed) {
  console.log('\nRe-run with --yes to deploy.')
  return
}

// 3. Deploy with the same JWT setting as now (new functions default to verify_jwt=true).
const verifyJwt = current ? current.verify_jwt : true
run('npx', ['--yes', 'supabase', 'functions', 'deploy', slug, '--project-ref', projectRef(), '--use-api',
  ...(verifyJwt ? [] : ['--no-verify-jwt'])], { cwd: REPO, env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken() } })

// 4. Verify what is live now.
const after = (await api('/functions')).find((f) => f.slug === slug)
const liveRoot = downloadLive(slug)
const mismatch = compare(source, readTree(liveRoot))
if (mismatch.length) {
  console.error(`Live source does not match the deployed files:\n  ${mismatch.join('\n  ')}`)
  process.exitCode = 1
  return
}

// 5. Record.
writeSnapshot(slug, liveRoot, after)
if (!fs.existsSync(DEPLOY_LOG)) fs.writeFileSync(DEPLOY_LOG, '# Edge Function deploys\n\n| date (UTC) | function | version | commit |\n|---|---|---|---|\n')
fs.appendFileSync(DEPLOY_LOG, `| ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${slug} | v${after.version} | ${commit} |\n`)
console.log(`Deployed ${slug} v${after.version} from ${commit}; live matches the source. Commit supabase/live-functions and supabase/DEPLOYS.md.`)
}
