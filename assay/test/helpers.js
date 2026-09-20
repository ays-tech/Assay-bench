import { createMockGateway, MOCK_KEY } from '../src/mock/gateway.js';
import { resolveConfig } from '../src/config.js';
import { runAudit } from '../src/agent.js';
import { OrbioClient } from '../src/client.js';

/**
 * Run a complete audit against a fresh mock gateway and return the report.
 * @param {object} [opts]
 * @param {string[]} [opts.faults]
 * @param {object} [opts.mock]        extra options for the mock gateway
 * @param {object} [opts.baseline]    if set, also start a baseline mock with these options
 * @param {object} [opts.config]      config overrides
 */
export async function auditMock({ faults = [], mock: mockOpts = {}, baseline, config: overrides = {} } = {}) {
  const gateway = await createMockGateway({ faults, ...mockOpts });
  const direct = baseline ? await createMockGateway({ seed: 99, ...baseline }) : null;
  try {
    const config = {
      ...resolveConfig({ key: MOCK_KEY, 'base-url': gateway.baseUrl }, {}),
      settleTimeoutMs: 4000,
      settlePollMs: 60,
      ...overrides,
    };
    const baselineClient = direct ? new OrbioClient({ baseUrl: direct.baseUrl, apiKey: MOCK_KEY, label: 'baseline' }) : null;
    const result = await runAudit({ config, baselineClient });
    return { ...result, gateway, direct, byId: Object.fromEntries(result.report.checks.map((c) => [c.id, c])) };
  } finally {
    await gateway.close();
    await direct?.close();
  }
}
