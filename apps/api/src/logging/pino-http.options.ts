import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import { stdSerializers } from 'pino';

/**
 * The pino-http configuration behind `LoggerModule.forRoot`. Kept in one
 * place so a test can boot the same logger against an in-memory stream.
 *
 * 2026-09-12: production showed a Drizzle "Failed query: …" 500 with no
 * reason. Two things hid it — pino-http's default `wrapSerializers` runs
 * the stock error serializer first, which flattens `cause` to a suffix on
 * the message and drops its fields (the SQLSTATE lives there), and Nest's
 * ExceptionsHandler logs a re-synthesised `{message, stack}` rather than
 * the thrown object. `wrapSerializers: false` + `errWithCause` keep the
 * whole chain; `AllExceptionsFilter` hands pino-http the real exception.
 */
export function pinoHttpOptions(): Options {
  return {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customProps: (req) => ({ requestId: req.id }),
    wrapSerializers: false,
    serializers: { err: stdSerializers.errWithCause },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.body.password',
        'req.body.token',
      ],
      censor: '[redacted]',
    },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
  };
}
