import { Observable, Subject } from 'rxjs';
import { logger } from '../../core/logger';

/**
 * Supported archive lifecycle event names.
 */
export type ArchiveEventType = 'archive-start' | 'archive-finish';

/**
 * Event emitted for archive lifecycle transitions.
 */
export interface ArchiveEvent {
  /** Event type identifying lifecycle phase. */
  type: ArchiveEventType;
  /** Unix epoch milliseconds for event time. */
  occurredAtMs: number;
  /** Pending file count for the batch. */
  totalFiles: number;
  /** Pending event-directory count for the batch. */
  totalEvents: number;
  /** Optional trigger files to materialize for legacy consumers. */
  triggerFilePaths?: string[];
  /** Number of files verified as archived when finishing. */
  archivedFiles?: number;
  /** Whether the cycle succeeded when finishing. */
  succeeded?: boolean;
}

/**
 * Handler contract for archive event side effects.
 */
export interface ArchiveEventHandler {
  /** Handles one emitted archive event. */
  handle(event: ArchiveEvent): Promise<void>;
}

/**
 * Function-style consumer for archive events.
 */
export type ArchiveEventConsumer = (event: ArchiveEvent) => void | Promise<void>;

/**
 * Event bus abstraction used by lifecycle code.
 */
export interface ArchiveEventBusLike {
  /** Publishes one archive event to all subscribers and observers. */
  publish(event: ArchiveEvent): Promise<void>;
  /** Registers a consumer and returns an unsubscribe callback. */
  subscribe(consumer: ArchiveEventConsumer): () => void;
}

/**
 * In-process archive event bus with observable stream and handler fan-out.
 */
export class ArchiveEventBus implements ArchiveEventBusLike {
  /** Backing subject for archive event observers. */
  private readonly subject = new Subject<ArchiveEvent>();
  /** Registered runtime consumers for fan-out side effects. */
  private readonly consumers = new Set<ArchiveEventConsumer>();

  /** Observable stream of all emitted archive events. */
  readonly events$: Observable<ArchiveEvent> = this.subject.asObservable();

  /**
   * Publishes an event and executes all subscribed consumers.
   */
  async publish(event: ArchiveEvent): Promise<void> {
    this.subject.next(event);

    for (const consumer of this.consumers) {
      try {
        await consumer(event);
      } catch (error) {
        logger.warn({ error, eventType: event.type }, 'Archive event consumer failed');
      }
    }
  }

  /**
   * Subscribes a runtime consumer and returns an unsubscribe callback.
   */
  subscribe(consumer: ArchiveEventConsumer): () => void {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }
}
