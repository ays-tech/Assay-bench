import { parseKeyResponse } from './balance.js';
import { abs, formatDecimal, max, parseDecimal, resolutionOf } from '../decimal.js';

const INVALID_KEY = 'sk-assay-invalid-key-000000000000';

/** @type {import('./index.js').Check} */
export const authCheck = {
  id: 'auth',
  title: 'Credentials and balance endpoint',
  weight: 5,
  method:
    'Reads GET /key and GET /auth/key, checks the two agree, then sends a deliberately invalid key and expects 401 or 403.',
  limits: 'Does not test key rotation, per-key limits enforcement or wallet-signed keys.',

  async run(ctx) {
    const key = await ctx.client.get('/key');

    if (key.status === 401 || key.status === 403) {
      ctx.fatal = 'the gateway rejected the credential';
      return {
        status: 'fail',
        summary: `Gateway rejected your key (HTTP ${key.status}). Claim or top up the key, then re-run.`,
        measured: { status: key.status },
      };
    }

    const balance = parseKeyResponse(key.json);
    if (!key.ok || balance.available === null) {
      return {
        status: 'fail',
        summary: `GET /key returned HTTP ${key.status} without a readable balance. Run \`assay probe\` to see the raw shape.`,
        measured: { status: key.status },
        details: { body: key.text },
      };
    }
    ctx.state.startBalance = balance;

    /** @type {string[]} */
    const notes = [];
    let status = /** @type {'pass'|'warn'|'fail'} */ ('pass');

    // OpenRouter-compatible view of the same balance.
    const compat = await ctx.client.get('/auth/key');
    const compatBalance = parseKeyResponse(compat.json);
    if (compat.status === 404 || compatBalance.available === null) {
      notes.push('/auth/key (OpenRouter shape) unavailable');
      status = 'warn';
    } else {
      const slack = max(resolutionOf([balance.availableRaw, compatBalance.availableRaw]), parseDecimal('0.000001'));
      if (abs(compatBalance.available - balance.available) > slack) {
        notes.push('/auth/key disagrees with /key');
        status = 'warn';
      }
    }

    if (!balance.rateLimit) notes.push('no rate_limit block in /key');

    // Negative control: a gateway that accepts garbage credentials is a serious problem.
    const bad = await ctx.client.withKey(INVALID_KEY).request('/key');
    let badKey = 'rejected';
    if (bad.status === 401 || bad.status === 403) {
      badKey = `rejected (${bad.status})`;
    } else if (bad.ok) {
      return {
        status: 'fail',
        summary: 'The gateway accepted an invalid API key on /key. Authentication is not being enforced.',
        measured: { badKeyStatus: bad.status },
      };
    } else {
      badKey = `inconclusive (${bad.status})`;
      notes.push(`bad-key probe returned ${bad.status}`);
      status = status === 'pass' ? 'warn' : status;
    }

    return {
      status,
      summary: `Balance $${formatDecimal(balance.available)} readable; invalid key ${badKey}${notes.length ? `; ${notes.join('; ')}` : ''}.`,
      measured: {
        available: formatDecimal(balance.available, 9),
        used: balance.used === null ? null : formatDecimal(balance.used, 9),
        balanceDecimals: balance.availableRaw?.split('.')[1]?.length ?? 0,
        rateLimit: balance.rateLimit,
        badKeyStatus: bad.status,
      },
    };
  },
};
