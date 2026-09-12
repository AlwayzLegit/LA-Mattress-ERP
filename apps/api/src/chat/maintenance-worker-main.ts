import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ChatService } from './chat.service';
async function main() {
  const env = process.env;
  if (
    env.CHAT_ENABLED !== 'true' ||
    !env.DATABASE_URL ||
    !env.CHAT_BUSINESS_ID ||
    !['staging', 'production'].includes(env.CHAT_ENVIRONMENT ?? '')
  )
    throw Error('Explicit chat maintenance configuration required');
  const connection = postgres(env.DATABASE_URL, { max: 2 });
  const chat = new ChatService(
    drizzle(connection),
    env.CHAT_ENVIRONMENT as 'staging' | 'production',
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
      await chat.maintenance(env.CHAT_BUSINESS_ID);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } finally {
    await connection.end();
  }
}
void main().catch(() => {
  console.error('Chat maintenance stopped. Check configuration and database.');
  process.exitCode = 1;
});
