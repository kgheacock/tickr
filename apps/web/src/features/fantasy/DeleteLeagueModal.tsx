/**
 * Admin-only "are you sure?" dialog for permanently deleting a league. Every
 * fs_* table cascades off fs_league, so confirming wipes the league and all its
 * data (members, rosters, draft, scores, season history). On success it
 * invalidates the shared `myLeagues` cache (dropping the league from the
 * homepage list) and closes.
 *
 * Follows the SellModal destructive-confirm pattern (kicker + bold warning +
 * Cancel/confirm), the app's established way of asking before an irreversible
 * action.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client, ApiClientError } from '../../api/client';
import { Modal, Button } from '../../components';
import { fantasyKeys } from './api';
import styles from './DeleteLeagueModal.module.css';

export function DeleteLeagueModal({
  leagueId,
  leagueName,
  onClose,
}: {
  leagueId: string;
  leagueName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const del = useMutation({
    mutationFn: () => client.deleteLeague(leagueId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: fantasyKeys.myLeagues });
      onClose();
    },
  });

  const err =
    del.error instanceof ApiClientError
      ? del.error.message
      : del.error
        ? 'Could not delete this league.'
        : null;

  return (
    <Modal onClose={onClose} kicker="Delete League" title={leagueName}>
      <p className={styles.confirmBody}>
        Permanently delete <strong>{leagueName}</strong> and everything in it —
        every team, roster, draft, and the full scoring history. This can’t be
        undone.
      </p>
      {err && <p className={styles.warn}>{err}</p>}
      <div className={styles.actions}>
        <Button onClick={() => del.mutate()} disabled={del.isPending}>
          {del.isPending ? 'Deleting…' : 'Delete league'}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={del.isPending}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
