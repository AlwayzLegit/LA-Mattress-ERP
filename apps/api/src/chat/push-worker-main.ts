import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ChatPushWorker, vapidSender } from './chat-push-worker';
async function main() {
  const env = process.env;
  if (
    env.CHAT_ENABLED !== 'true' ||
    env.CHAT_PUSH_ENABLED !== 'true' ||
    !env.DATABASE_URL ||
    !env.CHAT_BUSINESS_ID ||
    !env.CHAT_VAPID_PUBLIC_KEY ||
    !env.CHAT_VAPID_PRIVATE_KEY ||
    !env.CHAT_VAPID_SUBJECT ||
    !['staging', 'production'].includes(env.CHAT_ENVIRONMENT ?? '')
  )
    throw Error('Explicit push worker configuration required');
  const db = postgres(env.DATABASE_URL, { max: 3 });
  const worker = new ChatPushWorker(
    drizzle(db),
    vapidSender(env.CHAT_VAPID_SUBJECT, env.CHAT_VAPID_PUBLIC_KEY, env.CHAT_VAPID_PRIVATE_KEY),
    env.CHAT_ENVIRONMENT!,
  );
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  process.on('SIGTERM', () => {
    stop = true;
  });
  try {
    while (!stop) {
      if (!(await worker.runOnce(env.CHAT_BUSINESS_ID)))
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await db.end();
  }
}
void main().catch(() => {
  console.error('Chat push worker stopped. Check its configuration and database.');
  process.exitCode = 1;
});
