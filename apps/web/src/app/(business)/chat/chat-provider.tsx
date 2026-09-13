'use client';
import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useChatAvailability } from './use-chat-availability';
import { useLiveChatEngine } from './use-live-chat';
import styles from './chat.module.css';
const ChatContext = createContext<
  | (ReturnType<typeof useLiveChatEngine> & {
      availability: ReturnType<typeof useChatAvailability>;
    })
  | null
>(null);
export function useLiveChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('Chat provider required');
  return value;
}
export function ChatProvider({ children }: { children: ReactNode }) {
  const engine = useLiveChatEngine();
  const availability = useChatAvailability();
  const chat = { ...engine, availability };
  const pathname = usePathname();
  const waiting = chat.conversations.filter(
    (row) => !row.assignedMembershipId && ['queued', 'open'].includes(row.status),
  );
  const count = chat.unread.length;
  return (
    <ChatContext.Provider value={chat}>
      {children}
      {pathname !== '/chat' &&
        chat.connection !== 'denied' &&
        (chat.connection === 'live' || chat.conversations.length > 0) && (
          <aside className={styles.globalAlert} aria-label="Live chat alerts">
            <Link
              href="/chat"
              onClick={() => {
                const next =
                  chat.conversations.find((row) => chat.unread.includes(row.id)) ?? waiting[0];
                if (next) chat.select(next.id);
              }}
            >
              <strong>
                {count
                  ? `${count} unread chat${count === 1 ? '' : 's'}`
                  : waiting.length
                    ? `${waiting.length} waiting for help`
                    : 'Chat inbox'}
              </strong>
              <span>{chat.connection === 'live' ? 'Open inbox →' : 'Reconnecting…'}</span>
            </Link>
            <button aria-pressed={chat.sound} onClick={() => void chat.toggleSound()}>
              {chat.sound ? 'Sound on' : 'Enable sound'}
            </button>
            <span role="status" className={styles.screenReaderOnly}>
              {count ? 'New chat messages. Open the chat inbox to respond.' : ''}
            </span>
          </aside>
        )}
    </ChatContext.Provider>
  );
}
