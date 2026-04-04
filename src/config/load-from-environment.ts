import { ENV_TO_CONFIG_KEY } from './env-to-config-key';
import { parseTypedValue } from './parse-typed-value';

export function loadFromEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [envKey, configKey] of Object.entries(ENV_TO_CONFIG_KEY)) {
    const value = env[envKey];
    if (value !== undefined) {
      result[configKey] = parseTypedValue(envKey, value);
    }
  }

  return result;
}
