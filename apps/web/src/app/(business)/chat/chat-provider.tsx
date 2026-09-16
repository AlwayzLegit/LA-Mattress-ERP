'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useTeamChat } from './use-team-chat';
import { TeamWorkspace } from './team-workspace';
import { useChatHelp } from './use-chat-help';
import { useChatAvailability } from './use-chat-availability';
import { useManagedPush } from './use-managed-push';
import { useLiveChatEngine } from './use-live-chat';
const ChatContext = createContext<
  | (ReturnType<typeof useLiveChatEngine> & {
      availability: ReturnType<typeof useChatAvailability>;
      help: ReturnType<typeof useChatHelp>;
      team: ReturnType<typeof useTeamChat>;
    })
  | null
>(null);
export function useLiveChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('Chat provider required');
  return value;
}
export function ChatProvider({ children }: { children: ReactNode }) {
  const availability = useChatAvailability();
  const engine = useLiveChatEngine(availability.policy);
  useManagedPush(availability.policy, engine.notifications);
  const help = useChatHelp(['live', 'reconnecting'].includes(engine.connection), engine.notifyHelp);
  const team = useTeamChat(['live', 'reconnecting'].includes(engine.connection), engine.notifyHelp);
  const chat = { ...engine, availability, help, team };
  // Owner 2026-09-16: no floating "Chat inbox / Team workspace / Sound"
  // dock — the topbar inbox and /chat carry it.
  return (
    <ChatContext.Provider value={chat}>
      {children}
      <TeamWorkspace />
    </ChatContext.Provider>
  );
}
