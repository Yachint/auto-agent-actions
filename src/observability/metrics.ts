const METRICS_KEY = "auto-agent-actions:metrics";
const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

interface RedisMetricsClient {
  hset?(key: string, field: string, value: number): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface MetricsRecorder {
  record(name: string, increment?: number): Promise<void>;
}

export interface MetricsProvider {
  snapshot(): Promise<Readonly<Record<string, number>>>;
}

export class RedisOperationalMetrics
  implements MetricsRecorder, MetricsProvider
{
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

  async gauge(name: string, value: number): Promise<void> {
    validateMetricName(name);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      this.#redis.hset === undefined
    )
      throw new TypeError("invalid gauge");
    await this.#redis.hset(METRICS_KEY, name, value);
  }

  async observe(name: string, milliseconds: number): Promise<void> {
    validateMetricName(name);
    await this.record(`${name}_sum`, milliseconds);
    await this.record(`${name}_count`);
    for (const bound of [1000, 10000, 60000, 300000, 1800000, Infinity]) {
      if (milliseconds <= bound)
        await this.record(
          `${name}_bucket_le_${bound === Infinity ? "inf" : bound}`,
        );
    }
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

export function renderPrometheusMetrics(
  values: Readonly<Record<string, number>>,
): string {
  return `${Object.entries(values)
    .filter(
      ([name, value]) =>
        METRIC_NAME_PATTERN.test(name) && Number.isFinite(value),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const bucket = /^(.*)_bucket_le_(inf|[0-9]+)$/.exec(name);
      return bucket
        ? `auto_agent_actions_${bucket[1]}_bucket{le="${bucket[2] === "inf" ? "+Inf" : bucket[2]}"} ${value}`
        : `auto_agent_actions_${name} ${value}`;
    })
    .join("\n")}\n`;
}

function validateMetricName(name: string): void {
  if (!METRIC_NAME_PATTERN.test(name))
    throw new TypeError("metric name is invalid");
}
