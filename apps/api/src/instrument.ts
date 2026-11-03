// Sentry must be initialized before any other imports so its instrumentation
// can patch Node's HTTP/DB modules. Import this file first in main.ts.
import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';

type Integration = Extract<NonNullable<NodeOptions['integrations']>, unknown[]>[number];

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  // The CPU profiler is a native addon that ships prebuilt binaries only for
  // the Node majors Sentry supports. Requiring it on any other major (a
  // developer on Node 24, say) throws MODULE_NOT_FOUND and takes the API down
  // at boot — before Sentry is even configured. Load it lazily, only when a
  // DSN is set, and keep running without profiles if the binary is missing.
  const integrations: Integration[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const profiling = require('@sentry/profiling-node') as {
      nodeProfilingIntegration: () => Integration;
    };
    integrations.push(profiling.nodeProfilingIntegration());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`Sentry profiling disabled: ${reason.split(/\r?\n/)[0]}`);
  }
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    integrations,
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
