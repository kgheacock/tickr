/**
 * Confirm-then-drop dialog for selling an owned stock back to the wire. Shared
 * by the My Team roster, the waiver wire, and the stock report so a sell always
 * asks the same way. Drives the shared ctx.sellPlayer mutation.
 */
import type { LeagueContext } from './useLeague';
import { ApiClientError } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Button } from '../../components';
import { StockMasthead } from './StockMasthead';
import styles from './SellModal.module.css';

export function SellModal({
  ctx,
  symbol,
  name,
  onClose,
}: {
  ctx: LeagueContext;
  symbol: string;
  name: string | null;
  onClose: () => void;
}) {
  const { sellPlayer } = ctx;
  const err =
    sellPlayer.error instanceof ApiClientError
      ? sellPlayer.error.message
      : sellPlayer.error
        ? 'Could not sell this stock.'
        : null;

  // The mutation lives on the shared league context, so its error outlives this
  // modal — clear it on close so the next Sell prompt opens clean.
  const close = () => {
    sellPlayer.reset();
    onClose();
  };

  const onConfirm = () => sellPlayer.mutate(symbol, { onSuccess: onClose });

  return (
    <Modal
      onClose={close}
      kicker="Sell"
      label={`Sell ${symbol}`}
      masthead={<StockMasthead symbol={symbol} name={name} />}
    >
      <p className={styles.confirmBody}>
        Drop <strong>{symbol}</strong> from your team and return it to the wire?
        This opens a roster spot and can’t be undone.
      </p>
      {err && <p className={styles.warn}>{err}</p>}
      <div className={styles.actions}>
        <Button onClick={onConfirm} disabled={sellPlayer.isPending}>
          {sellPlayer.isPending ? 'Selling…' : `Sell ${symbol}`}
        </Button>
        <Button
          variant="secondary"
          onClick={close}
          disabled={sellPlayer.isPending}
        >
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
