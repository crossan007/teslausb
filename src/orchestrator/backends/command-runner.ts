/**
 * Legacy lineage:
 * - run/rsync_archive/archive-is-reachable.sh
 * - run/rsync_archive/archive-clips.sh
 *
 * New TypeScript infrastructure for executing the same external command model.
 */
export {
  CommandResult,
  StreamingCommandHandlers,
  CommandRunner,
  ChildProcessCommandRunner,
  defaultCommandRunner,
} from '../../shared/command-runner';
