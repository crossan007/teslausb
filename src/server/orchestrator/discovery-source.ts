import { Observable } from 'rxjs';
import { ClipDiscoveryResult } from './clip-discovery/clip-discovery-manager';

/**
 * Structural contract expected from any discovery source (snapshot consumer, test fake, etc.).
 */
export interface DiscoverySource {
  readonly discovered$: Observable<ClipDiscoveryResult>;
  start(): void;
  stop(): void;
}
