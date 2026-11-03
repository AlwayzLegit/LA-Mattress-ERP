import './instrument';

import compression from 'compression';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody:true preserves the request body so the Stripe webhook
  // handler can verify signatures (Stripe signs the unparsed bytes).
  // Other routes still receive the parsed JSON via Nest's default body
  // parser.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  // STORIS import CSVs arrive as JSON body text; the express default of
  // 100kb would reject any real export file.
  app.useBodyParser('json', { limit: '25mb' });
  // Report and board payloads run 50–500 KB of JSON; gzip cuts them 8–10×
  // on the API → Vercel-proxy hop and for direct API clients. Streams stay
  // uncompressed: the chat SSE feeds must flush each event as it happens.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) =>
        !String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream') &&
        !req.headers.accept?.includes('text/event-stream') &&
        compression.filter(req, res),
    }),
  );

  // CORS_ORIGIN is a comma-separated allow-list; entries may contain a
  // single `*` wildcard (e.g. https://*-teamslug.vercel.app) so Vercel
  // preview deployments — which mint a unique subdomain per push — can
  // reach the API without editing env vars on every deploy.
  const corsPatterns = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const matchesOrigin = (origin: string): boolean =>
    corsPatterns.some((p) =>
      p.includes('*')
        ? new RegExp(`^${p.split('*').map(escapeRegExp).join('[a-z0-9-]+')}$`, 'i').test(origin)
        : p === origin,
    );
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || matchesOrigin(origin)),
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  app.get(Logger).log(`API listening on port ${port}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void bootstrap();
