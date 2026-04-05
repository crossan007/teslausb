import { useEffect, useState, useRef, useCallback } from 'react';
import { getConfig } from './config';

/**
 * Custom hook for REST API calls with error handling
 */
export function useApi<T>(
  endpoint: string,
  options: { interval?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    try {
      setLoading(true);
      const config = getConfig();
      const response = await window.fetch(
        `${config.apiBaseUrl}${endpoint}`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    fetch();

    if (options.interval) {
      const interval = setInterval(fetch, options.interval);
      return () => clearInterval(interval);
    }
  }, [fetch, options.interval]);

  return { data, loading, error };
}

/**
 * Message types for WebSocket communication
 */
export type WebSocketMessage =
  | {
      type: 'transfer-session-update';
      data: any;
    }
  | {
      type: 'snapshots-update';
      data: any;
    }
  | {
      type: 'system-status-update';
      data: any;
    };

/**
 * Custom hook for WebSocket connection with automatic reconnection
 */
export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectDelay = useRef(1000);

  const connect = useCallback(() => {
    if (!url) {
      return;
    }

    try {
      console.log(`Connecting to WebSocket: ${url}`);
      ws.current = new WebSocket(url);

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        reconnectAttempts.current = 0;
        reconnectDelay.current = 1000;
      };

      ws.current.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          setLastMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);

        // Attempt to reconnect with exponential backoff
        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = reconnectDelay.current;
          console.log(
            `Attempting to reconnect in ${delay}ms...`,
          );
          setTimeout(() => {
            reconnectAttempts.current++;
            reconnectDelay.current = Math.min(
              reconnectDelay.current * 2,
              30000,
            );
            connect();
          }, delay);
        } else {
          console.error(
            'Max reconnection attempts reached, giving up',
          );
        }
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      setIsConnected(false);
    }
  }, [url]);

  useEffect(() => {
    if (!url) {
      setIsConnected(false);
      setLastMessage(null);
      return;
    }

    connect();

    return () => {
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
    };
  }, [connect]);

  return { isConnected, lastMessage };
}

/**
 * Convenience hook that combines REST fallback with WebSocket push
 */
export function useRealtimeData<T>(
  endpoint: string,
  wsMessageType: string,
  wsData: any,
) {
  const { data: restData } = useApi<T>(endpoint, { interval: 5000 });
  const wsResult = useWebSocket(''); // Will be initialized in component

  // Prefer WebSocket data if available and recent, fallback to REST
  const wsValue = wsData?.type === wsMessageType ? wsData.data : null;

  return wsValue ?? restData;
}
