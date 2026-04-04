import { readFileSync } from 'fs';
import { logger } from '../core/logger';
import { ConfigSchema, TeslaUSBConfig } from '../types';
import { loadFromEnvironment } from './load-from-environment';
import { envKeyToConfigKey } from './env-to-config-key';
import { parseTypedValue } from './parse-typed-value';

/**
 * Loads and validates TeslaUSB configuration from /root/teslausb_setup_variables.conf
 * Falls back to environment variables for each config key.
 */
export class ConfigLoader {
	private config: TeslaUSBConfig | null = null;

	constructor(private configPath: string = '/root/teslausb_setup_variables.conf') {}

	/**
	 * Load and validate configuration.
	 * Throws if configuration is invalid.
	 */
	load(): TeslaUSBConfig {
		if (this.config) {
			return this.config;
		}

		const envConfig = loadFromEnvironment();
		const fileConfig = this.loadFromFile();
		const merged = { ...envConfig, ...fileConfig };

		try {
			this.config = ConfigSchema.parse(merged);
			logger.info({ config: this.sanitizeLogging(this.config) }, 'Configuration loaded');
			return this.config;
		} catch (error) {
			logger.error({ error, merged }, 'Configuration validation failed');
			throw new Error(`Invalid configuration: ${error}`);
		}
	}

	/**
	 * Get cached config, or load if not already loaded.
	 */
	get(): TeslaUSBConfig {
		return this.config ?? this.load();
	}

	/**
	 * Load configuration from file (/root/teslausb_setup_variables.conf).
	 * File is sourced as bash and parsed line by line.
	 */
	private loadFromFile(): Record<string, unknown> {
		try {
			const content = readFileSync(this.configPath, 'utf-8');
			const result: Record<string, unknown> = {};

			const exportRegex = /^\s*export\s+(\w+)=(.*)$/gm;
			let match;

			while ((match = exportRegex.exec(content)) !== null) {
				const [, envKey, value] = match;
				const configKey = envKeyToConfigKey(envKey);
				if (configKey) {
					const trimmedValue = value.replace(/^["']|["']$/g, '').trim();
					result[configKey] = parseTypedValue(envKey, trimmedValue);
				}
			}

			logger.debug({ path: this.configPath, keysLoaded: Object.keys(result).length }, 'Config file loaded');
			return result;
		} catch (error) {
			logger.warn({ path: this.configPath, error }, 'Failed to load config file');
			return {};
		}
	}

	/**
	 * Remove sensitive data for logging
	 */
	private sanitizeLogging(config: TeslaUSBConfig): Partial<TeslaUSBConfig> {
		const sanitized = { ...config };
		const sensitiveKeys = ['sharePassword', 'teslaPassword', 'pushoverUserKey', 'tessieApiToken'];
		for (const key of sensitiveKeys) {
			if (key in sanitized) {
				(sanitized as any)[key] = '***';
			}
		}
		return sanitized;
	}
}

export const configLoader = new ConfigLoader();
