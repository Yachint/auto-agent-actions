const METRICS_KEY = "auto-agent-actions:metrics";
const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

interface RedisMetricsClient {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface MetricsRecorder {
  record(name: string, increment?: number): Promise<void>;
}

export interface MetricsProvider {
  snapshot(): Promise<Readonly<Record<string, number>>>;
}

export class RedisOperationalMetrics implements MetricsRecorder, MetricsProvider {
  readonly #redis: RedisMetricsClient;

  constructor(redis: RedisMetricsClient) {
    this.#redis = redis;
  }

  async record(name: string, increment = 1): Promise<void> {
    validateMetricName(name);
    if (!Number.isSafeInteger(increment) || increment < 0) {
      throw new TypeError("metric increment must be a non-negative integer");
    }
    await this.#redis.hincrby(METRICS_KEY, name, increment);
  }

  async snapshot(): Promise<Readonly<Record<string, number>>> {
    const stored = await this.#redis.hgetall(METRICS_KEY);
    const result: Record<string, number> = {};
    for (const [name, value] of Object.entries(stored)) {
      if (!METRIC_NAME_PATTERN.test(name) || !/^\d+$/.test(value)) continue;
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed)) result[name] = parsed;
    }
    return Object.freeze(result);
  }
}

export function renderPrometheusMetrics(values: Readonly<Record<string, number>>): string {
  return `${Object.entries(values)
    .filter(([name, value]) => METRIC_NAME_PATTERN.test(name) && Number.isFinite(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `auto_agent_actions_${name} ${value}`)
    .join("\n")}\n`;
}

function validateMetricName(name: string): void {
  if (!METRIC_NAME_PATTERN.test(name)) throw new TypeError("metric name is invalid");
}
