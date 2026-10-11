import { randomBytes } from 'node:crypto';

const project = 'ltjhlaprtjgmmijfnmri';
const name = 'SUBSCRIPTION_MONITOR_SECRET';
const vaultName = 'kingboard_subscription_monitor_secret';
const endpoint = `https://${project}.supabase.co/functions/v1/subscription_monitor`;
const mode = process.argv[2];
let stage = 'start';
async function management(path, method = 'GET', body) {
  stage = `${method}:${path}`;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw Error('management_token_missing');
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`management_${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const sql = query => management('database/query', 'POST', { query });
async function storedSecret() {
  const rows = await sql(`select decrypted_secret from vault.decrypted_secrets where name='${vaultName}'`);
  if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].decrypted_secret)) throw Error('monitor_secret_unavailable');
  return rows[0].decrypted_secret;
}
try {
  if (mode === 'configure') {
    const rows = await sql(`select name from vault.secrets where name='${vaultName}'`);
    const secrets = await management('secrets');
    if (!rows.length && secrets.some(s => s.name === name)) throw Error('existing_edge_secret_without_vault_stop');
    const secret = rows.length ? await storedSecret() : randomBytes(32).toString('hex');
    if (!rows.length) await sql(`select vault.create_secret('${secret}', '${vaultName}', 'Scoped subscription monitor invocation only') is not null as created`);
    await management('secrets', 'POST', [{ name, value: secret }]);
    console.log(JSON.stringify({ configured: true, existing_secrets_unchanged: true }));
  } else if (mode === 'test' || mode === 'scan') {
    const secret = await storedSecret();
    const response = await fetch(endpoint, {method:'POST',headers:{'x-monitor-secret':secret,'Content-Type':'application/json'},
      body:JSON.stringify(mode==='test'?{self_test:true}:{}),signal:AbortSignal.timeout(120000)});
    const result = await response.json().catch(()=>({}));
    console.log(JSON.stringify({status:response.status, self_test:result.self_test,delivered:result.delivered,
      checked:result.checked,matched:result.matched,missing:result.missing,insufficient:result.insufficient,
      failed:!response.ok}));
    if (!response.ok) process.exitCode=1;
  } else if (mode === 'schedule') {
    await storedSecret();
    const result = await sql(`select cron.schedule('kingboard_subscription_monitor', '*/15 * * * *', $job$
      select net.http_post(url := '${endpoint}',
        headers := jsonb_build_object('Content-Type','application/json','x-monitor-secret',
          (select decrypted_secret from vault.decrypted_secrets where name='${vaultName}')),
        body := '{}'::jsonb, timeout_milliseconds := 120000);
    $job$) as job_id`);
    console.log(JSON.stringify({scheduled:true,interval_minutes:15,job_id:result[0].job_id}));
  } else throw Error('expected_configure_test_scan_or_schedule');
} catch (error) {
  // Never print response bodies, credentials, request objects, or fetch error causes.
  const safe = /^(management_\d+|management_token_missing|monitor_secret_unavailable|existing_edge_secret_without_vault_stop|expected_configure_test_scan_or_schedule)$/;
  console.error(JSON.stringify({ stage, error: safe.test(error.message) ? error.message : 'operation_failed', type:error.name }));
  process.exitCode=1;
}
