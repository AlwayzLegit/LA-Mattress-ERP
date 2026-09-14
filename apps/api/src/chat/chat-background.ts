import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ChatWorker, AblyChatPublisher } from './chat-worker';
import { ChatPushWorker, vapidSender } from './chat-push-worker';
import { ChatService } from './chat.service';

type Job = { name: string; interval: number; run: () => Promise<unknown> };

/** One in-flight invocation per job. Persistent database leases survive API restarts. */
export class ChatBackground implements OnApplicationBootstrap, OnModuleDestroy {
  private stopped = false;
  private tasks: Promise<void>[] = [];
  private wakeups = new Set<() => void>();
  private readonly logger = new Logger(ChatBackground.name);

  constructor(private readonly jobs: Job[]) {}

  onApplicationBootstrap() {
    this.tasks = this.jobs.map((job) => this.loop(job));
    if (this.jobs.length) this.logger.log('Embedded chat background jobs started');
  }

  private async loop(job: Job) {
    while (!this.stopped) {
      let delay = job.interval;
      try {
        const worked = await job.run();
        if (worked === false) delay = Math.max(delay, 1000);
      } catch {
        // Do not log provider errors: they can contain credentials or message content.
        this.logger.error(`${job.name} failed; retrying in 5 seconds`);
        delay = 5000;
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.wakeups.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, delay);
        this.wakeups.add(wake);
      });
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    for (const wake of this.wakeups) wake();
    await Promise.all(this.tasks);
  }
}

export function createChatBackground(
  db: PostgresJsDatabase,
  chat: ChatService,
  env: NodeJS.ProcessEnv,
): ChatBackground {
  if (env.CHAT_EMBEDDED_WORKERS !== 'true') return new ChatBackground([]);
  const business = env.CHAT_BUSINESS_ID;
  const environment = env.CHAT_ENVIRONMENT;
  if (
    env.CHAT_ENABLED !== 'true' ||
    !business ||
    !env.ABLY_API_KEY ||
    (environment !== 'staging' && environment !== 'production')
  ) {
    throw new Error(
      'Embedded chat requires enabled chat, business, environment and Ably configuration',
    );
  }
  const delivery = new ChatWorker(
    db,
    new AblyChatPublisher(env.ABLY_API_KEY, environment),
    environment,
  );
  const jobs: Job[] = [
    { name: 'Chat delivery', interval: 100, run: () => delivery.runOnce(business) },
    { name: 'Chat maintenance', interval: 3000, run: () => chat.maintenance(business) },
  ];
  if (env.CHAT_PUSH_ENABLED === 'true') {
    const {
      CHAT_VAPID_PUBLIC_KEY: publicKey,
      CHAT_VAPID_PRIVATE_KEY: privateKey,
      CHAT_VAPID_SUBJECT: subject,
    } = env;
    if (!publicKey || !privateKey || !subject)
      throw new Error('Embedded chat push requires VAPID configuration');
    const push = new ChatPushWorker(db, vapidSender(subject, publicKey, privateKey), environment);
    jobs.push({ name: 'Chat push', interval: 250, run: () => push.runOnce(business) });
  }
  return new ChatBackground(jobs);
}
