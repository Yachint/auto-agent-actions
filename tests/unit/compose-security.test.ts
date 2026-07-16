import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = {
  read_only?: boolean;
  user?: string;
  cap_drop?: string[];
  security_opt?: string[];
  ports?: string[];
  labels?: string[];
  networks?: string[];
  secrets?: string[];
  environment?: Record<string, unknown>;
  volumes?: Array<string | { source?: string; target?: string }>;
  command?: string[];
};

describe("Compose security boundaries", () => {
  it("keeps credentials, networks, ports, and writable storage in their intended services", async () => {
    const root = process.cwd();
    const compose = parse(await readFile(path.join(root, "compose.yaml"), "utf8"), {
      merge: true,
    }) as {
      services: Record<string, Service>;
      networks: Record<string, { internal?: boolean }>;
    };
    const { redis, server, publisher, analysis } = compose.services;
    expect(redis && server && publisher && analysis).toBeTruthy();
    expect(Object.keys(compose.services).sort()).toEqual([
      "analysis",
      "publisher",
      "redis",
      "server",
    ]);

    expect(
      Object.entries(compose.services)
        .filter(([, service]) => (service.ports?.length ?? 0) > 0)
        .map(([name]) => name),
    ).toEqual([]);
    expect(server!.networks).toEqual(["backend", "edge"]);
    expect(publisher!.networks).toEqual(["backend", "egress"]);
    expect(analysis!.networks).toEqual(["backend", "egress"]);
    expect(redis!.networks).toEqual(["backend"]);
    expect(compose.networks.backend?.internal).toBe(true);
    expect(compose.networks.edge?.internal).toBe(true);
    expect(compose.networks.edge).toEqual(
      expect.objectContaining({ name: "auto-agent-actions-edge" }),
    );

    expect(server!.secrets).toEqual(["github_webhook_secret"]);
    expect(publisher!.secrets).toEqual([
      "github_app_private_key",
      "read_token_broker_secret",
    ]);
    expect(analysis!.secrets).toEqual(["read_token_broker_secret"]);
    expect(server!.environment).not.toHaveProperty("GITHUB_APP_ID");
    expect(analysis!.environment).not.toHaveProperty("GITHUB_APP_ID");
    expect(analysis!.environment).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY_FILE");
    expect(publisher!.environment).not.toHaveProperty("CODEX_HOME");

    expect(volumeTargets(analysis!)).toContain("/var/lib/codex");
    expect(volumeTargets(publisher!)).not.toContain("/var/lib/codex");
    expect(volumeTargets(server!)).not.toContain("/var/lib/codex");

    for (const service of [server!, publisher!, analysis!]) {
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toContain("ALL");
      expect(service.security_opt).toContain("no-new-privileges:true");
    }
    for (const service of [server!, publisher!, analysis!]) {
      expect(service.user).toBe("1000:1000");
    }
    expect(redis!.command).toEqual(expect.arrayContaining(["--appendonly", "yes"]));
    expect(server!.labels).toEqual(
      expect.arrayContaining([
        "traefik.enable=true",
        "traefik.docker.network=auto-agent-actions-edge",
        "traefik.http.routers.auto-agent-actions.entrypoints=websecure",
        "traefik.http.routers.auto-agent-actions.tls.certresolver=letsencrypt",
        "traefik.http.services.auto-agent-actions.loadbalancer.server.port=3000",
      ]),
    );
    const routerRule = server!.labels?.find((label) => label.includes(".rule="));
    expect(routerRule).toContain("Path(`/webhooks/github`)");
    expect(routerRule).not.toContain("PathPrefix");
    expect(server!.labels?.join("\n")).not.toContain("/metrics");
    expect(server!.labels?.join("\n")).not.toContain("/health/ready");
  });
});

function volumeTargets(service: Service): string[] {
  return (service.volumes ?? []).map((volume) => {
    if (typeof volume === "string") return volume.split(":")[1] ?? "";
    return volume.target ?? "";
  });
}
