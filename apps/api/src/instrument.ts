// Sentry must be initialized before any other imports so its instrumentation
// can patch Node's HTTP/DB modules. Import this file first in main.ts.
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? '0.1'),
    beforeSend(event) {
      if (event.request?.url?.includes('/v1/chat/')) {
        return {
          ...event,
          request: undefined,
          breadcrumbs: [],
          extra: undefined,
          contexts: {},
          exception: { values: [{ type: 'ChatRequestError', value: 'Chat request failed' }] },
        };
      }
      return event;
    },
    // DB spans can contain transcript parameters. Keep chat traces local until
    // a metadata-only trace integration has been verified.
    beforeSendTransaction(event) {
      return event.request?.url?.includes('/v1/chat/') ? null : event;
    },
  });
}
