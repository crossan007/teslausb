/**
 * Client-side configuration loaded from backend or environment
 */
interface ClientConfig {
  apiBaseUrl: string;
  wsUrl: string;
}

let config: ClientConfig | null = null;

/**
 * Load configuration from backend /api/config endpoint or fallback to defaults
 */
export async function loadConfig(): Promise<ClientConfig> {
  if (config) {
    return config;
  }

  try {
    // Try to load from backend first
    const response = await fetch('/api/config');
    if (response.ok) {
      config = await response.json();
      return config;
    }
  } catch (error) {
    console.warn('Failed to load config from backend, using defaults');
  }

  // Fallback to environment variables or defaults
  config = {
    apiBaseUrl:
      process.env.REACT_APP_API_BASE_URL || window.location.origin,
    wsUrl:
      process.env.REACT_APP_WS_URL ||
      (window.location.protocol === 'https:' ? 'wss:' : 'ws:') +
        '//' +
        window.location.host,
  };

  return config;
}

export function getConfig(): ClientConfig {
  if (!config) {
    throw new Error('Config not loaded; call loadConfig() first');
  }
  return config;
}
