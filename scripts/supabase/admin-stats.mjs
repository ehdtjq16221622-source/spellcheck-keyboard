#!/usr/bin/env node
// Calls the admin_stats function with the admin token kept on this PC.
// Usage: node scripts/supabase/admin-stats.mjs [deviceId] [--history]
// Token: ADMIN_API_TOKEN env, or the file ~/.kingboard/admin-token (never commit it).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectRef } from './lib.mjs'

const file = path.join(os.homedir(), '.kingboard', 'admin-token')
const token = process.env.ADMIN_API_TOKEN || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '')
if (!token) {
  console.error(`No admin token: set ADMIN_API_TOKEN or create ${file}`)
  process.exit(2)
}
const deviceId = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const body = deviceId ? { deviceId, history: process.argv.includes('--history') } : {}
const response = await fetch(`https://${projectRef()}.supabase.co/functions/v1/admin_stats`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
  body: JSON.stringify(body),
})
console.log(JSON.stringify(await response.json(), null, 2))
// exitCode instead of exit(): exiting right after fetch trips a libuv assertion on Windows.
process.exitCode = response.ok ? 0 : 1
