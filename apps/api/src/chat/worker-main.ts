import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { AblyChatPublisher, ChatWorker } from './chat-worker';
async function main() {
  const { DATABASE_URL, CHAT_BUSINESS_ID, CHAT_ENVIRONMENT, ABLY_API_KEY } = process.env;
  if (
    !DATABASE_URL ||
    !CHAT_BUSINESS_ID ||
    !ABLY_API_KEY ||
    !['staging', 'production'].includes(CHAT_ENVIRONMENT ?? '') ||
    process.env.CHAT_ENABLED !== 'true'
  )
    throw new Error('Explicit chat worker configuration is required');
  const environment = CHAT_ENVIRONMENT as 'staging' | 'production';
  const sql = postgres(DATABASE_URL, { max: 3 });
  const db = drizzle(sql);
  const worker = new ChatWorker(db, new AblyChatPublisher(ABLY_API_KEY, environment), environment);
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  try {
    while (!stopping) {
      if (!(await worker.runOnce(CHAT_BUSINESS_ID)))
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
void main().catch(() => {
  console.error('Chat worker stopped; inspect database and provider health.');
  process.exitCode = 1;
});
