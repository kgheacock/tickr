/**
 * Create-league form, shown as a modal dialog (FS-14 item 3). Collects the
 * commissioner's team name and a roster of seats — each seat either a human
 * invited by email or an auto-manager (bot). League capacity is derived from the
 * seat count (1 + members, must land in 4–12). Seasons are "continuous" by
 * default, which maps to a long fixed season (52 weeks); toggle it off to set a
 * shorter run. On success it invalidates the shared `myLeagues` cache and routes
 * to the new league's dashboard.
 *
 * NOTE: invite *email delivery* isn't wired yet — a labelled invite is created
 * server-side but nothing is sent. See TODO/fantasy-street/14-polish.md.
 *
 * The dialog shell (centering, dimmed backdrop, Escape/backdrop/×-to-close,
 * focus trapping) lives in the reusable <Modal>; this component owns only the
 * create-league form.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { client, ApiClientError } from '../../api/client';
import {
  Modal,
  Button,
  IconButton,
  Input,
  Checkbox,
  Field,
} from '../../components';
import { fantasyKeys } from './api';
import styles from './CreateLeagueModal.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTINUOUS_WEEKS = 52;
const MIN_MEMBERS = 3; // 1 commissioner + 3 = 4, the league minimum
const MAX_MEMBERS = 11; // 1 commissioner + 11 = 12, the league maximum

interface Seat {
  id: string;
  email: string;
  isBot: boolean;
}

// A stable, collision-proof key per seat. Generated in event handlers (never
// inside a setState updater) so StrictMode's double-invocation can't mint two
// seats that share an id and break list reconciliation.
const freshSeat = (): Seat => ({
  id: crypto.randomUUID(),
  email: '',
  isBot: false,
});

export function CreateLeagueModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [continuous, setContinuous] = useState(true);
  const [weeks, setWeeks] = useState(14);
  const [seats, setSeats] = useState<Seat[]>(() => [
    freshSeat(),
    freshSeat(),
    freshSeat(),
  ]);

  const patchSeat = (id: string, patch: Partial<Seat>) =>
    setSeats((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const addSeat = () => {
    const seat = freshSeat();
    setSeats((prev) => (prev.length < MAX_MEMBERS ? [...prev, seat] : prev));
  };
  const removeSeat = (id: string) =>
    setSeats((prev) =>
      prev.length > MIN_MEMBERS ? prev.filter((s) => s.id !== id) : prev,
    );

  const seatsValid = seats.every(
    (s) => s.isBot || EMAIL_RE.test(s.email.trim()),
  );
  const canSubmit =
    name.trim().length > 0 &&
    teamName.trim().length > 0 &&
    seats.length >= MIN_MEMBERS &&
    seatsValid &&
    (continuous || weeks >= 1);

  const create = useMutation({
    mutationFn: () =>
      client.createLeague({
        name: name.trim(),
        teamName: teamName.trim(),
        seasonLengthWeeks: continuous ? CONTINUOUS_WEEKS : Number(weeks),
        joinPolicy: 'invite',
        members: seats.map((s) =>
          s.isBot ? { isBot: true } : { isBot: false, email: s.email.trim() },
        ),
      }),
    onSuccess: async (league) => {
      await queryClient.invalidateQueries({ queryKey: fantasyKeys.myLeagues });
      navigate(`/leagues/${league.id}`);
    },
  });

  const errorMessage =
    create.error instanceof ApiClientError
      ? create.error.message
      : create.error
        ? 'Could not create the league. Please try again.'
        : null;

  return (
    <Modal onClose={onClose} kicker="Fantasy Street" title="Start a League">
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit && !create.isPending) create.mutate();
        }}
      >
        <div className={styles.row}>
          <Field label="League name">
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bear Market Bulls"
              maxLength={80}
              required
              autoFocus
            />
          </Field>

          <Field label="Your team">
            <Input
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="The Dip Buyers"
              maxLength={80}
              required
            />
          </Field>
        </div>

        <fieldset className={styles.seats}>
          <legend className={styles.label}>Managers</legend>
          <ul className={styles.seatList}>
            {seats.map((seat, i) => (
              <li key={seat.id} className={styles.seat}>
                <span className={styles.seatNum}>{i + 2})</span>
                <Input
                  className={styles.seatEmail}
                  type="email"
                  value={seat.isBot ? '' : seat.email}
                  onChange={(e) =>
                    patchSeat(seat.id, { email: e.target.value })
                  }
                  placeholder={
                    seat.isBot ? 'Auto-manager' : 'manager@email.com'
                  }
                  disabled={seat.isBot}
                  aria-label={`Manager ${i + 2} email`}
                />
                <Checkbox
                  className={styles.botToggle}
                  label="Bot"
                  title="Fill this seat with an auto-manager"
                  checked={seat.isBot}
                  onChange={(e) =>
                    patchSeat(seat.id, { isBot: e.target.checked })
                  }
                />
                <IconButton
                  tone="danger"
                  size="sm"
                  onClick={() => removeSeat(seat.id)}
                  disabled={seats.length <= MIN_MEMBERS}
                  aria-label={`Remove manager ${i + 2}`}
                >
                  ×
                </IconButton>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            className={styles.addSeat}
            onClick={addSeat}
            disabled={seats.length >= MAX_MEMBERS}
          >
            + Add manager
          </Button>
        </fieldset>

        <div className={styles.season}>
          <Checkbox
            className={styles.checkLabel}
            label="Continuous season"
            checked={continuous}
            onChange={(e) => setContinuous(e.target.checked)}
          />
          {continuous ? null : (
            <Field label="Weeks" className={styles.weeksField}>
              <Input
                type="number"
                min={1}
                value={weeks}
                onChange={(e) => setWeeks(e.target.valueAsNumber || 0)}
              />
            </Field>
          )}
        </div>

        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || create.isPending}>
            {create.isPending ? 'Starting…' : 'Start League'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
