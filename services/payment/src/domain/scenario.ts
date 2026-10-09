export interface Scenario {
  readonly fail: string | null;
  readonly delaySeconds: number | null;
  readonly webhook: 'normal' | 'drop' | 'duplicate';
  readonly responseTimeout: boolean;
}

export class InvalidScenarioError extends Error {
  override name = 'InvalidScenarioError';
}

export const MAX_DELAY_SECONDS = 3600;

export const DEFAULT_SCENARIO: Scenario = {
  fail: null,
  delaySeconds: null,
  webhook: 'normal',
  responseTimeout: false,
};

const FAIL_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DELAY = /^[1-9][0-9]{0,3}$/;

/** Phân tích header `X-Simulate`. Giá trị lạ, khóa lạ hay khóa lặp đều bị từ chối, không đoán. */
export function parseScenario(header: string | undefined): Scenario {
  if (header === undefined || header.trim() === '') return DEFAULT_SCENARIO;

  const seen = new Set<string>();
  let fail: string | null = null;
  let delaySeconds: number | null = null;
  let webhook: Scenario['webhook'] = 'normal';
  let responseTimeout = false;

  for (const rawToken of header.split(',')) {
    const token = rawToken.trim();
    const eq = token.indexOf('=');
    if (eq <= 0 || eq === token.length - 1) {
      throw new InvalidScenarioError(`malformed token "${token}", expected key=value`);
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (seen.has(key)) throw new InvalidScenarioError(`duplicate key "${key}"`);
    seen.add(key);

    switch (key) {
      case 'fail':
        if (!FAIL_CODE.test(value)) {
          throw new InvalidScenarioError(`fail code "${value}" must match ${FAIL_CODE.source}`);
        }
        fail = value;
        break;
      case 'delay': {
        if (!DELAY.test(value) || Number(value) > MAX_DELAY_SECONDS) {
          throw new InvalidScenarioError(`delay must be an integer in 1..${MAX_DELAY_SECONDS}`);
        }
        delaySeconds = Number(value);
        break;
      }
      case 'webhook':
        if (value !== 'drop' && value !== 'duplicate') {
          throw new InvalidScenarioError('webhook must be "drop" or "duplicate"');
        }
        webhook = value;
        break;
      case 'response':
        if (value !== 'timeout') throw new InvalidScenarioError('response must be "timeout"');
        responseTimeout = true;
        break;
      default:
        throw new InvalidScenarioError(`unknown key "${key}"`);
    }
  }

  return { fail, delaySeconds, webhook, responseTimeout };
}
