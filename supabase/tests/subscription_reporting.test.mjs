import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/subscription_reporting.ts', import.meta.url), 'utf8');
const { buildRenewalOutcomes, decodeApplePayload, groupSubscriptionPeople, renewalState,
  latestPersonSubscription, selectAppleSubscription, subscriptionStatusText } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const now = Date.parse('2026-10-27T12:00Z');
const day = 86400_000;
const product = tier => `com.kingboard.app.monthly_${tier}`;
const signed = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
const tx = (id, tier, start, end, more = {}) => ({ transactionId: id, originalTransactionId: 'chain-1',
  productId: product(tier), purchaseDate: now + start * day, expiresDate: now + end * day,
  environment: 'Production', transactionReason: 'PURCHASE', ...more });
const observation = (history, status = 1, more = {}) => ({ chain: 'chain-1', owner: 'private-owner', history,
  current: { status, chain: 'chain-1', transaction: history.at(-1), renewal: { autoRenewStatus: 1 } },
  historyComplete: true, lookupFailed: false, ...more });
const report = (history, status = 1, more = {}) => buildRenewalOutcomes([[observation(history, status, more)]], now);

test('missing or malformed renewal information is unknown, never cancellation', () => {
  assert.equal(renewalState(null), 'unknown');
  assert.equal(renewalState({}), 'unknown');
  assert.equal(renewalState({ autoRenewStatus: '0' }), 'unknown');
  assert.equal(renewalState({ autoRenewStatus: 0 }), 'off');
  assert.equal(renewalState({ autoRenewStatus: 1, autoRenewProductId: product('pro') }), 'on');
  assert.equal(decodeApplePayload('broken'), null);
});

test('current Apple transaction is selected across every group, not the first old plan', () => {
  const old = tx('old', 'basic', -40, -10, { isUpgraded: true });
  const current = tx('new', 'pro', -10, 20);
  const selected = selectAppleSubscription({ data: [
    { lastTransactions: [{ status: 2, originalTransactionId: 'chain-1', signedTransactionInfo: signed(old) }] },
    { lastTransactions: [{ status: 1, originalTransactionId: 'chain-1', signedTransactionInfo: signed(current),
      signedRenewalInfo: signed({ autoRenewStatus: 1, autoRenewProductId: product('premium') }) }] },
  ] }, 'chain-1');
  assert.equal(selected.transaction.productId, product('pro'));
  assert.equal(selected.renewal.autoRenewProductId, product('premium'));
});

test('same-plan renewal and immediate upgrade are two kinds of retention', () => {
  assert.equal(report([tx('a', 'basic', -40, -10), tx('b', 'basic', -10, 20, { transactionReason: 'RENEWAL' })]).same_plan, 1);
  const result = report([tx('a', 'basic', -12, 18, { isUpgraded: true }), tx('b', 'pro', -2, 28)]);
  assert.equal(result.changed_plan, 1);
  assert.equal(result.expired, 0);
  assert.equal(result.renewal_rate, 100);
});

test('turning renewal off before expiry is not actual churn', () => {
  const result = report([tx('a', 'basic', -10, 20)], 1);
  assert.equal(result.expired, 0);
  assert.equal(result.not_due, 1);
  assert.equal(result.denominator, 0);
  assert.equal(result.renewal_rate, null);
});

test('actual expiry, billing pending, refunds and unreadable histories stay separate', () => {
  const history = [tx('a', 'premium', -35, -5)];
  assert.equal(report(history, 2).expired, 1);
  assert.equal(report(history, 3).pending_billing, 1);
  assert.equal(report(history, 4).pending_billing, 1);
  assert.equal(report([tx('a', 'premium', -35, -5, { revocationDate: now - day })], 5).refunded, 1);
  assert.equal(report(history, 5).unknown, 1);
  assert.equal(report([tx('a', 'premium', -160, -130, { revocationDate: now - 120 * day })], 5).refunded, 0);
  assert.equal(report(history, 2, { historyComplete: false }).unknown, 1);
  assert.equal(report(history, 2, { historyComplete: false }).denominator, 0);
});

test('same-plan and different-plan resubscriptions after expiry are not renewals', () => {
  for (const [tier, field] of [['basic', 'resubscribed_same_plan'], ['premium', 'resubscribed_changed_plan']]) {
    const result = report([tx('a', 'basic', -80, -50), tx('b', tier, -5, 25, { originalTransactionId: 'new-chain' })]);
    assert.equal(result[field], 1);
    assert.equal(result.expired, 0);
    assert.equal(result.renewal_rate, 0);
    assert.equal(result.denominator, 1);
  }
});

test('payment recovery remains renewal; an unexplained gap is unknown', () => {
  const history = [tx('a', 'basic', -40, -10), tx('b', 'basic', -8, 22, { transactionReason: 'RENEWAL' })];
  assert.equal(report(history).same_plan, 1);
  delete history[1].transactionReason;
  assert.equal(report(history).unknown, 1);
});

test('verified account or overlapping Apple histories link separate original transaction IDs once', () => {
  const old = tx('a', 'basic', -40, -10);
  const next = tx('b', 'pro', -5, 25, { originalTransactionId: 'chain-2' });
  const a = observation([old, next]);
  const b = observation([next], 1, { chain: 'chain-2', owner: 'other-wallet' });
  let groups = groupSubscriptionPeople([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(buildRenewalOutcomes(groups, now).resubscribed_changed_plan, 1);
  groups = groupSubscriptionPeople([observation([old]), observation([next], 1, { chain: 'chain-2' })]);
  assert.equal(groups.length, 1);
});

test('each person has only their latest decision, duplicate transactions do not inflate counts', () => {
  const a = tx('a', 'basic', -70, -40), b = tx('b', 'basic', -40, -10), c = tx('c', 'premium', -10, 20);
  const result = report([a, b, b, c, c]);
  assert.equal(result.changed_plan, 1);
  assert.equal(result.same_plan, 0);
  assert.equal(result.denominator, 1);
});

test('telegram distinguishes intent from outcomes and never exposes private identifiers', () => {
  const result = report([tx('a', 'basic', -40, -10), tx('b', 'pro', -5, 25)]);
  const text = subscriptionStatusText({ auto_renew_on_now: 7, auto_renew_off_now: 2,
    auto_renew_unknown_now: 1, renewal_outcomes: result }, true);
  assert.match(text, /중단 비율 22.2%/);
  assert.match(text, /확인 불가 1명/);
  assert.match(text, /다른 플랜 1명/);
  assert.doesNotMatch(text, /해지율|private-owner|chain-1/);
});

test('unreadable current transactions cannot outrank a valid transaction', () => {
  const expired = tx('a', 'basic', -40, -10);
  const selected = selectAppleSubscription({ data: [{ lastTransactions: [
    { status: 1, signedTransactionInfo: 'broken' },
    { status: 2, signedTransactionInfo: signed(expired) },
  ] }] }, 'chain-1');
  assert.equal(selected.status, 2);
  assert.equal(selectAppleSubscription({ data: [{ lastTransactions: [{ status: 1 }] }] }, 'chain-1'), null);
});

test('latest signed renewal settings win when purchase dates are identical', () => {
  const a = observation([tx('a', 'basic', -10, 20)]);
  const b = observation(a.history);
  a.current.renewal = { autoRenewStatus: 0, signedDate: now - 1000 };
  b.current.renewal = { autoRenewStatus: 1, signedDate: now };
  assert.equal(latestPersonSubscription([a, b]).renewal.autoRenewStatus, 1);
  assert.equal(latestPersonSubscription([b, a]).renewal.autoRenewStatus, 1);
});
