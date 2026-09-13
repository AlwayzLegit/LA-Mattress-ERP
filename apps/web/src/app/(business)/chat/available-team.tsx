'use client';
import { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { useLiveChat } from './chat-provider';
import styles from './chat.module.css';
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };

export function PassChatButton({ memberId, name }: { memberId?: string; name?: string }) {
  const { conversations, selected, team } = useLiveChat();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState('');
  const chat = conversations.find((row) => row.id === selected);
  const others =
    team.directory?.people.filter((p) => p.available && p.id !== team.directory?.membershipId) ??
    [];
  const enabled =
    chat?.assignedToMe &&
    !['resolved', 'spam', 'snoozed'].includes(chat.status) &&
    (memberId ? others.some((p) => p.id === memberId) : others.length > 0);
  return (
    <div className={styles.passControl}>
      <Button
        disabled={!enabled || busy}
        title={
          !chat?.assignedToMe
            ? 'Select a chat assigned to you first'
            : 'Ask an available teammate to take over'
        }
        onClick={async () => {
          if (lock.current || !chat?.version || !enabled) return;
          lock.current = true;
          setBusy(true);
          setNotice('');
          try {
            await api(`/v1/chat/conversations/${chat.id}/${memberId ? 'transfer' : 'workflow'}`, {
              method: 'POST',
              headers,
              body: JSON.stringify(
                memberId
                  ? { membershipId: memberId, version: chat.version }
                  : { action: 'release', version: chat.version },
              ),
            });
            setNotice(
              memberId
                ? `Passed to ${name}. Waiting for acceptance.`
                : 'Team alerted. First available teammate to accept takes over.',
            );
          } catch (e) {
            setNotice(e instanceof Error ? e.message : 'Pass failed. Please retry.');
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? 'Passing…' : memberId ? `Pass this chat to ${name}` : 'Pass to team'}
      </Button>
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}
export function AvailableTeam() {
  const { team, connection } = useLiveChat();
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const ready = Boolean(team.directory) && !team.error && connection === 'live';
  const people = ready
    ? team.directory!.people.filter((p) => p.available).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return (
    <section className={styles.availableTeam} aria-label="Available chat teammates">
      <div className={styles.availableTeamHeading}>
        <h2>Available now {ready && <span>{people.length}</span>}</h2>
        <PassChatButton />
      </div>
      <ul className={styles.availableTeamList}>
        {people.map((person) => (
          <li key={person.id}>
            <button
              disabled={busy !== null || person.id === team.directory!.membershipId}
              title={
                person.id === team.directory!.membershipId
                  ? 'You are available'
                  : `Chat privately with ${person.name} or pass a visitor`
              }
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(person.id);
                setError('');
                try {
                  const room = await api<{ id: string }>('/v1/chat/conversations/team/rooms', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ kind: 'direct', memberId: person.id }),
                  });
                  await team.refresh();
                  team.setDirectTarget({ id: person.id, name: person.name, roomId: room.id });
                  team.setRoomId(room.id);
                  team.setOpen(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not open teammate chat');
                } finally {
                  lock.current = false;
                  setBusy(null);
                }
              }}
            >
              <span className={styles.availablePersonDot} aria-hidden="true" />
              {person.name}
              {person.id === team.directory!.membershipId ? ' (you)' : ''}
              {busy === person.id ? '…' : ''}
            </button>
          </li>
        ))}
      </ul>
      {!people.length && <p>{ready ? 'No teammates available' : 'Checking availability…'}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
