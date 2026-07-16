export function parseEnvironmentFile(contents: string): Readonly<Record<string, string>>;
export function validatePreflightEnvironment<T extends Readonly<Record<string, string>>>(
  environment: T,
): T;
