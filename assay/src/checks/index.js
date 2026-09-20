import { authCheck } from './auth.js';
import { catalogCheck } from './catalog.js';
import { billingCheck } from './billing.js';
import { tokensCheck } from './tokens.js';
import { identityCheck } from './identity.js';
import { compatCheck } from './compat.js';
import { latencyCheck } from './latency.js';

/**
 * @typedef {'pass'|'warn'|'fail'|'skip'|'info'} Status
 *
 * @typedef {object} CheckOutcome
 * @property {Status} status
 * @property {string} summary        one plain-language sentence with the numbers
 * @property {boolean} [escalate]    ask the agent to re-run this check with a larger sample
 * @property {Record<string, any>} [measured]  small, dashboard-friendly values
 * @property {Record<string, any>} [details]   evidence for the expandable row
 *
 * @typedef {object} Check
 * @property {string} id
 * @property {string} title
 * @property {number} weight
 * @property {string} method   how it is tested
 * @property {string} limits   what it cannot prove
 * @property {(ctx: import('../agent.js').AuditContext, opts?: {escalated?: boolean}) => Promise<CheckOutcome>} run
 */

/** Execution order matters: catalog selects models, billing/identity collect the records tokens analyses. @type {Check[]} */
export const CHECKS = [authCheck, catalogCheck, billingCheck, identityCheck, tokensCheck, compatCheck, latencyCheck];
