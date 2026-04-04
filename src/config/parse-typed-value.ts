/**
 * Legacy lineage:
 * - setup/pi/envsetup.sh (shell-string to typed runtime value conversion)
 */
import { BOOLEAN_ENV_KEYS } from './boolean-env-keys';
import { NUMERIC_ENV_KEYS } from './numeric-env-keys';

export function parseTypedValue(envKey: string, value: string): string | number | boolean {
  if (BOOLEAN_ENV_KEYS.has(envKey)) {
    return value === 'true';
  }
  if (NUMERIC_ENV_KEYS.has(envKey)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return value;
}
