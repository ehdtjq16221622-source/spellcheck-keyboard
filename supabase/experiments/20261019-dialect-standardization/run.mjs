import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('./', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, here), 'utf8'));
const cases = read('cases.json');
const prepared = read('prepared.json');

export function plan({ includePaidOff = false } = {}) {
  return cases.flatMap((sample) => {
    const variants = sample.id % 2 ? ['before', 'after'] : ['after', 'before'];
    return (includePaidOff ? [true, false] : [true]).flatMap((includeDialect) => variants.map((variant) => ({
      caseId: sample.id, variant, includeDialect,
    })));
  });
}

export async function run(args = process.argv.slice(2)) {
  const includePaidOff = args.includes('--include-paid-off');
  const slots = plan({ includePaidOff });
  const correctionLimit = includePaidOff ? 120 : 60;
  const providerLimit = correctionLimit * 4;
  assert.equal(slots.length, correctionLimit);
  if (!args.includes('--run') || !args.includes('--approve-paid-ai')) {
    console.log(`PREPARATION ONLY: 30 fixed synthetic cases x before/after x ${includePaidOff ? 'ON/OFF (optional)' : 'ON'} = ${correctionLimit} corrections.`);
    console.log(`Expected ${correctionLimit} primary provider calls; at most ${providerLimit} attempts in ONE runner pass including production fallback/retry. Not a global multi-isolate cap.`);
    console.log('OFF prompt verification is offline by default. Paid OFF additionally requires --include-paid-off --approve-paid-off and a server-side opt-in.');
    console.log('No network. Separate deployment, opening-window and paid-AI approval are required.');
    return;
  }
  assert.ok(!includePaidOff || args.includes('--approve-paid-off'), 'Separate paid OFF approval required');
  const endpoint = process.env.DIALECT_EXPERIMENT_URL;
  // Never permit an arbitrary destination to receive the credentials.
  assert.equal(endpoint, 'https://ltjhlaprtjgmmijfnmri.supabase.co/functions/v1/dialect_standardization_experiment', 'Approved experiment URL required');
  const token = process.env.DIALECT_EXPERIMENT_TOKEN;
  const jwt = process.env.DIALECT_EXPERIMENT_JWT;
  assert.ok(token && /^[a-f0-9]{64}$/.test(token), 'Experiment token required through environment');
  assert.ok(jwt && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt), 'Gateway JWT required through environment');
  const report = {
    startedAt: new Date().toISOString(), status: 'running', prepared, includePaidOff,
    correctionLimit, providerAttemptCeilingThisRunner: providerLimit, globalCeilingEnforced: false,
    providerAttempts: 0, results: [],
  };
  const output = new URL(`results-${Date.now()}.json`, here);
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    for (const slot of slots) {
      // No retry here: an uncertain timeout may already have spent provider calls.
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(100_000),
        headers: { Authorization: `Bearer ${jwt}`, 'x-dialect-experiment-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(slot),
      });
      if (!response.ok) throw new Error('EXPERIMENT_HTTP_STOP');
      const data = await response.json();
      assert.equal(data.caseId, slot.caseId);
      assert.equal(data.variant, slot.variant);
      assert.equal(data.includeDialect, slot.includeDialect);
      assert.equal(data.sourceSha256, prepared[slot.variant]);
      assert.equal(data.realDatabaseCalls, 0);
      assert.equal(data.realCreditOperations, 0);
      assert.ok(Array.isArray(data.calls) && data.calls.length <= 4);
      report.providerAttempts += data.calls.length;
      const row = {
        ...slot, input: cases.find((item) => item.id === slot.caseId).text,
        correctionStatus: data.correctionStatus, result: data.result, durationMs: data.durationMs,
        diagnosticId: data.diagnosticId, failureStage: data.failureStage,
        calls: data.calls, simulated: data.simulated,
      };
      // Defense against accidental credential echo; never save raw transport errors.
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes(token) && !serialized.includes(jwt));
      report.results.push(row);
      save();
      console.log(JSON.stringify({ completed: report.results.length, caseId: slot.caseId, variant: slot.variant, status: data.correctionStatus, providerAttempts: data.calls.length, durationMs: data.durationMs }));
      if (data.correctionStatus !== 200 || report.providerAttempts > providerLimit ||
          data.calls.some((call) => call.status === 200 && call.finishReason !== 'STOP')) {
        throw new Error('CORRECTION_STOP');
      }
    }
    report.status = 'completed_pending_human_review';
  } catch {
    report.status = 'aborted_do_not_retry_automatically';
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`${report.status}: ${report.results.length}/${correctionLimit} corrections saved. Set DIALECT_EXPERIMENT_OPEN=false now and verify closed; expiration alone is not cleanup.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
