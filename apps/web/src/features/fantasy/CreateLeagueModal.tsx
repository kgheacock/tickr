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
  Tooltip,
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

  // Per-seat result of the "is this email already a tickr account?" check,
  // keyed by seat id. 'missing' surfaces a non-blocking warning — the invite is
  // still created, the invitee just needs to sign in before they can claim the
  // team. Cleared whenever the seat's email or bot flag changes (see patchSeat)
  // so a stale verdict never lingers against a new address.
  const [lookups, setLookups] = useState<
    Record<string, 'checking' | 'exists' | 'missing'>
  >({});

  const patchSeat = (id: string, patch: Partial<Seat>) => {
    setSeats((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    if ('email' in patch || 'isBot' in patch) {
      setLookups((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  // On blur, check a filled-in human seat's email against the account base. Fire
  // only for a valid address (the warning is about real, registered people) and
  // skip if a verdict for this seat already stands — patchSeat clears it on edit,
  // so a lingering entry means the address is unchanged.
  const checkSeatEmail = (seat: Seat) => {
    const email = seat.email.trim();
    if (seat.isBot || !EMAIL_RE.test(email) || lookups[seat.id]) return;
    setLookups((prev) => ({ ...prev, [seat.id]: 'checking' }));
    client
      .checkUserExists(email)
      .then((res) =>
        setLookups((prev) =>
          // Ignore a late response if the seat was cleared/edited meanwhile.
          prev[seat.id] === 'checking'
            ? { ...prev, [seat.id]: res.exists ? 'exists' : 'missing' }
            : prev,
        ),
      )
      .catch(() =>
        setLookups((prev) => {
          if (prev[seat.id] !== 'checking') return prev;
          const next = { ...prev };
          delete next[seat.id];
          return next;
        }),
      );
  };
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
              id="league-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bear Market Bulls"
              maxLength={80}
              autoComplete="off"
              required
              autoFocus
            />
          </Field>

          <Field label="Your team">
            <Input
              id="team-name"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="The Dip Buyers"
              maxLength={80}
              autoComplete="off"
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
                  id={`seat-email-${seat.id}`}
                  className={styles.seatEmail}
                  type="email"
                  value={seat.isBot ? '' : seat.email}
                  onChange={(e) =>
                    patchSeat(seat.id, { email: e.target.value })
                  }
                  onBlur={() => checkSeatEmail(seat)}
                  placeholder={
                    seat.isBot ? 'Auto-manager' : 'manager@email.com'
                  }
                  autoComplete="off"
                  disabled={seat.isBot}
                  aria-label={`Manager ${i + 2} email`}
                />
                <span className={styles.seatStatus} aria-live="polite">
                  {lookups[seat.id] === 'missing' ? (
                    <Tooltip content="No tickr account yet — they'll need to sign in before they can claim this team.">
                      <span className={styles.warnIcon} aria-label="No account">
                        ⚠
                      </span>
                    </Tooltip>
                  ) : null}
                </span>
                <Checkbox
                  id={`seat-bot-${seat.id}`}
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
            id="continuous-season"
            className={styles.checkLabel}
            label="Continuous season"
            checked={continuous}
            onChange={(e) => setContinuous(e.target.checked)}
          />
          {continuous ? null : (
            <Field label="Weeks" className={styles.weeksField}>
              <Input
                id="season-weeks"
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
