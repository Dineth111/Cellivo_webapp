import crypto from 'node:crypto';
import { config } from '../../core/config.js';

/**
 * Payment gateway adapter. The provider is still an open item (SRS appendix E), so billing only talks to
 * this interface. To go live, add an adapter with the same three methods and select it with PAYMENT_GATEWAY:
 *
 *   tokenize({ number })                       -> { token, brand, last4 }     (hosted fields in production)
 *   charge({ token, amount, currency, ref })   -> { ok, ref, error? }         (amount in minor units)
 *   refund({ ref, amount })                    -> { ok, ref }
 *
 * The "test" gateway below needs no account. It is refused in production.
 * Test cards: any valid number works; 4000000000000002 is declined; 4000000000009995 is declined on renewal only.
 */
const DECLINED = '4000000000000002';
const RENEWAL_DECLINED = '4000000000009995';

const luhn = (n) => {
  let sum = 0;
  [...n].reverse().forEach((d, i) => { let x = +d; if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; });
  return sum % 10 === 0;
};

const testGateway = {
  name: 'test',
  async tokenize({ number }) {
    const n = String(number ?? '').replace(/\s|-/g, '');
    if (!/^\d{13,19}$/.test(n) || !luhn(n)) return { error: 'Card number is not valid' };
    const flag = n === DECLINED ? 'decline' : n === RENEWAL_DECLINED ? 'renewal_decline' : 'ok';
    return { token: `tok_${flag}_${crypto.randomBytes(6).toString('hex')}`, brand: n[0] === '4' ? 'Visa' : n[0] === '5' ? 'Mastercard' : 'Card', last4: n.slice(-4) };
  },
  async charge({ token, amount, renewal }) {
    if (!token) return { ok: false, error: 'No payment method on file' };
    if (token.startsWith('tok_decline') || (renewal && token.startsWith('tok_renewal_decline'))) return { ok: false, error: 'Your card was declined' };
    if (amount <= 0) return { ok: true, ref: 'free' };
    return { ok: true, ref: `ch_${crypto.randomBytes(8).toString('hex')}` };
  },
  async refund() {
    return { ok: true, ref: `re_${crypto.randomBytes(8).toString('hex')}` };
  },
};

const gateways = { test: testGateway };

export function gateway() {
  const g = gateways[config.paymentGateway];
  if (!g) throw new Error(`Unknown PAYMENT_GATEWAY "${config.paymentGateway}"`);
  if (g.name === 'test' && config.env === 'production') throw new Error('The test payment gateway cannot run in production');
  return g;
}
