// Shared helpers for the Supabase function scripts. Node 18+, no dependencies.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FUNCTIONS_DIR = path.join(REPO, 'supabase', 'functions')
export const LIVE_DIR = path.join(REPO, 'supabase', 'live-functions')
export const MANIFEST = path.join(LIVE_DIR, 'MANIFEST.json')
export const DEPLOY_LOG = path.join(REPO, 'supabase', 'DEPLOYS.md')

export function projectRef() {
  const file = path.join(REPO, 'supabase', '.temp', 'project-ref')
  return process.env.SUPABASE_PROJECT_REF ||
    (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : 'ltjhlaprtjgmmijfnmri')
}

export function accessToken() {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) {
    console.error('SUPABASE_ACCESS_TOKEN is not set (Supabase account access token).')
    process.exit(2)
  }
  return token
}

export async function api(pathname, init = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef()}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken()}`, ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`Supabase API ${pathname}: HTTP ${response.status}`)
  return response.json()
}

export function run(command, args, options = {}) {
  // Windows needs a shell for npx.cmd; pass one command string (arguments here never contain spaces).
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { encoding: 'utf8', shell: true, ...options })
    : spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

/** Downloads the live source of one function into a fresh temp folder; returns its supabase/functions path. */
export function downloadLive(slug) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live-${slug}-`))
  run('npx', ['--yes', 'supabase', 'functions', 'download', slug, '--project-ref', projectRef(), '--use-api'], {
    cwd: dir, env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken() },
  })
  return path.join(dir, 'supabase', 'functions')
}

/** Every file under a functions folder, as relative path -> text with line endings normalized. */
export function readTree(root) {
  const out = {}
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
    }
  }
  walk(root)
  return out
}

export const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Files a function uses in the source tree: its own folder plus the _shared files it imports (recursively). */
export function sourceFiles(slug) {
  const files = new Set()
  const visit = (relative) => {
    if (files.has(relative)) return
    const full = path.join(FUNCTIONS_DIR, relative)
    if (!fs.existsSync(full)) return
    files.add(relative)
    const text = fs.readFileSync(full, 'utf8')
    for (const match of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]|import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1] ?? match[2]))
      visit(target)
    }
  }
  const own = path.join(FUNCTIONS_DIR, slug)
  if (!fs.existsSync(own)) return []
  for (const [relative] of Object.entries(readTree(own))) visit(`${slug}/${relative}`)
  return [...files].sort()
}

export function compare(a, b) {
  const changed = []
  for (const file of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[file] !== b[file]) changed.push(`${file in a ? (file in b ? 'changed' : 'only-left') : 'only-right'}  ${file}`)
  }
  return changed.sort()
}

export function readManifest() {
  return fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { functions: {} }
}

export function writeSnapshot(slug, liveRoot, meta) {
  const target = path.join(LIVE_DIR, slug)
  fs.rmSync(target, { recursive: true, force: true })
  // fs.cpSync silently copies nothing into this repo path on Windows (non-ASCII folder name), so copy by hand.
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const name of fs.readdirSync(from)) {
      const source = path.join(from, name)
      if (fs.statSync(source).isDirectory()) copy(source, path.join(to, name))
      else fs.writeFileSync(path.join(to, name), fs.readFileSync(source))
    }
  }
  copy(liveRoot, target)
  const manifest = readManifest()
  const files = readTree(target)
  manifest.functions[slug] = {
    version: meta.version, verify_jwt: meta.verify_jwt, updated_at: meta.updated_at,
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, sha(text)])),
  }
  manifest.recorded_at = new Date().toISOString()
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}
