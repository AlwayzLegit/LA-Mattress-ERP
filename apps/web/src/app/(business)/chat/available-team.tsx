'use client';
import { useLiveChat } from './chat-provider';
import styles from './chat.module.css';

export function AvailableTeam() {
  const { team, connection } = useLiveChat();
  const ready = Boolean(team.directory) && !team.error && connection === 'live';
  const people = ready
    ? team
        .directory!.people.filter((person) => person.available)
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return (
    <section className={styles.availableTeam} aria-label="Available chat teammates">
      <div className={styles.availableTeamHeading}>
        <h2>Available now {ready && <span>{people.length}</span>}</h2>
        <small>
          {ready
            ? 'Online and accepting chats · updates automatically'
            : 'Checking team availability…'}
        </small>
      </div>
      {people.length > 0 ? (
        <ul className={styles.availableTeamList}>
          {people.map((person) => (
            <li key={person.id}>
              <span className={styles.availablePersonDot} aria-hidden="true" />
              <span>
                {person.name}
                {person.id === team.directory!.membershipId ? ' (you)' : ''}
              </span>
              <span className={styles.screenReaderOnly}> · Online and available</span>
            </li>
          ))}
        </ul>
      ) : ready ? (
        <p>No teammates are available right now.</p>
      ) : null}
    </section>
  );
}
