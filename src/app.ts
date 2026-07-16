import Fastify, { type FastifyInstance } from "fastify";

import {
  acceptGitHubWebhook,
  type WebhookDependencies,
  WebhookRequestError,
} from "./github/webhook.js";
import {
  renderPrometheusMetrics,
  type MetricsProvider,
  type MetricsRecorder,
} from "./observability/metrics.js";

export interface AppOptions {
  readonly webhook?: WebhookDependencies;
  readonly logLevel?: string;
  readonly readiness?: () => Promise<boolean>;
  readonly metrics?: MetricsProvider & MetricsRecorder;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? process.env.LOG_LEVEL ?? "info",
    },
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = options.readiness === undefined ? true : await options.readiness().catch(() => false);
    return ready
      ? reply.code(200).send({ status: "ready" })
      : reply.code(503).send({ status: "not_ready" });
  });
  if (options.metrics !== undefined) {
    app.get("/metrics", async (_request, reply) =>
      reply
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(renderPrometheusMetrics(await options.metrics!.snapshot())),
    );
  }

  if (options.webhook !== undefined) {
    const webhook = options.webhook;
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    app.post("/webhooks/github", async (request, reply) => {
      const signature = requireHeader(request.headers["x-hub-signature-256"]);
      const event = requireHeader(request.headers["x-github-event"]);
      const deliveryId = requireHeader(request.headers["x-github-delivery"]);
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "webhook body must be JSON" });
      }

      try {
        const result = await acceptGitHubWebhook(
          request.body,
          { signature, event, deliveryId },
          webhook,
        );
        if ("ping" in result) {
          request.log.info({ deliveryId, event }, "GitHub webhook ping accepted");
          return reply.code(200).send(result);
        }
        request.log.info(
          { deliveryId, event, enqueued: result.enqueued },
          "GitHub webhook accepted",
        );
        await options.metrics
          ?.record(result.enqueued ? "webhooks_enqueued_total" : "webhooks_duplicate_total")
          .catch((error: unknown) => {
            request.log.warn(
              { errorName: error instanceof Error ? error.name : "unknown" },
              "could not record webhook metric",
            );
          });
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof WebhookRequestError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    });
  }

  return app;
}

function requireHeader(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
