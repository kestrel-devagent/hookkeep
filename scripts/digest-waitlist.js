/**
 * Operator email digest for Hookkeep waitlist.
 * Prints a mailto: draft + plain-text body to stdout (no SMTP required).
 *
 * Usage: node scripts/digest-waitlist.js
 * Env: HOOKKEEP_DATA (optional), OPERATOR_EMAIL (default hudson.gouge@projxon.ai)
 */
import * as db from '../src/db.js';

const OPERATOR = process.env.OPERATOR_EMAIL || 'hudson.gouge@projxon.ai';
const BILLING = (
  process.env.BILLING_PUBLIC_URL ||
  process.env.STRIPE_BILLING_URL ||
  ''
).replace(/\/$/, '');

const rows = db.listWaitlist();
const now = new Date().toISOString();
const count = rows.length;

const lines = [
  `Hookkeep waitlist digest — ${now}`,
  `Total signups: ${count}`,
  '',
  'Pro unlock path:',
  BILLING
    ? `  Stripe Checkout: ${BILLING}/subscribe?product=hookkeep`
    : '  BILLING_PUBLIC_URL unset — customers hit /subscribe setup page; mint unlock code after payment/email.',
  '  Demo/test code: HOOKKEEP-PRO-DEMO01 (reusable)',
  '  Contact/pay: hudson.gouge@projxon.ai',
  '',
  '--- entries ---',
];

if (!count) {
  lines.push('(empty)');
} else {
  for (const r of rows) {
    const note = r.note ? ` | ${r.note}` : '';
    lines.push(`${r.at || '?'}  ${r.email}${note}`);
  }
}

const body = lines.join('\n');
const subject = `Hookkeep waitlist digest (${count})`;
const mailto =
  `mailto:${OPERATOR}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

console.log(body);
console.log('\n--- mailto draft ---');
console.log(mailto);
console.log('\n--- json ---');
console.log(JSON.stringify({ count, billingPublicUrl: BILLING || null, waitlist: rows }, null, 2));
