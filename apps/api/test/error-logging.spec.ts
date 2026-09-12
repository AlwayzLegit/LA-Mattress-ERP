/**
 * Unexpected errors must reach the request log as the thrown object, cause
 * and all (2026-09-12: a production "Failed query" 500 logged without the
 * Postgres reason). Boots a tiny Nest app on the production pino-http
 * options against an in-memory stream — no database needed.
 */
import { Writable } from 'node:stream';
import { Controller, Get, type INestApplication, NotFoundException } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from '../src/logging/all-exceptions.filter';
import { pinoHttpOptions } from '../src/logging/pino-http.options';

interface Line {
  msg?: string;
  err?: { message: string; cause?: { message: string; code?: string } };
  res?: { statusCode: number };
}

@Controller('boom')
class BoomController {
  @Get('query')
  query(): never {
    const pg = Object.assign(new Error('permission denied for table cash_pickup_receipts'), {
      code: '42501',
      severity: 'ERROR',
    });
    throw new DrizzleQueryError('select 1', [], pg);
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('no such thing');
  }
}

describe('unexpected errors in the request log', () => {
  let app: INestApplication;
  const lines: Line[] = [];

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _enc, cb) {
        for (const raw of String(chunk).split('\n')) {
          if (raw.trim()) lines.push(JSON.parse(raw) as Line);
        }
        cb();
      },
    });
    const opts = { ...pinoHttpOptions(), transport: undefined, level: 'info' };
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [opts, sink] })],
      controllers: [BoomController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs the thrown Drizzle error with its Postgres cause and SQLSTATE', async () => {
    lines.length = 0;
    await request(app.getHttpServer()).get('/boom/query').expect(500);
    const line = lines.find((l) => l.res?.statusCode === 500 && l.err);
    expect(line?.err?.message).toContain('Failed query: select 1');
    expect(line?.err?.cause?.message).toBe('permission denied for table cash_pickup_receipts');
    expect(line?.err?.cause?.code).toBe('42501');
  });

  it('keeps deliberate HTTP replies off the error path', async () => {
    lines.length = 0;
    const res = await request(app.getHttpServer()).get('/boom/missing').expect(404);
    expect(res.body.message).toBe('no such thing');
    expect(lines.some((l) => l.err)).toBe(false);
  });
});
