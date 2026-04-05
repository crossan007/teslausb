import { Subscription, ViewService } from './types';

/**
 * Base observable view service with subscription support
 */
export abstract class BaseViewService<T> implements ViewService<T> {
  private listeners = new Set<(data: T) => void>();

  abstract snapshot(): T;

  subscribe(listener: (data: T) => void): Subscription {
    listener(this.snapshot()); // Fire immediately
    this.listeners.add(listener);

    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  protected emit(): void {
    const current = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (error) {
        console.error('ViewService listener error:', error);
      }
    }
  }
}
