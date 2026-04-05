import { describe, expect, it } from 'vitest';
import { ArchiveEvent, ArchiveEventBus } from './event-bus';

describe('ArchiveEventBus', () => {
  it('publishes events to runtime consumers and observable subscribers', async () => {
    const bus = new ArchiveEventBus();

    const consumed: ArchiveEvent[] = [];
    const unsubscribeConsumer = bus.subscribe(async (event) => {
      consumed.push(event);
    });

    const observed: ArchiveEvent[] = [];
    const subscription = bus.events$.subscribe((event) => {
      observed.push(event);
    });

    const event: ArchiveEvent = {
      type: 'archive-start',
      occurredAtMs: Date.now(),
      totalFiles: 3,
      totalEvents: 1,
      triggerFilePaths: ['all.trigger'],
    };

    await bus.publish(event);

    subscription.unsubscribe();
    unsubscribeConsumer();

    expect(consumed).toEqual([event]);
    expect(observed).toEqual([event]);
  });
});
