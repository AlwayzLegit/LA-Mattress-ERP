import { describe, expect, it } from 'vitest';
import { chipFor, fmtDay, relativeDay } from './order-format';

describe('chipFor — display vocabulary onto the six status tones', () => {
  it('keeps the STORIS word and picks the tone', () => {
    expect(chipFor('Draft')).toEqual({ status: 'draft', label: 'Draft' });
    expect(chipFor('On PO')).toEqual({ status: 'waiting', label: 'On PO' });
    expect(chipFor('Reserved')).toEqual({ status: 'scheduled', label: 'Reserved' });
    expect(chipFor('Scheduled')).toEqual({ status: 'scheduled', label: 'Scheduled' });
    expect(chipFor('Delivered')).toEqual({ status: 'fulfilled', label: 'Delivered' });
    expect(chipFor('Cancelled')).toEqual({ status: 'cancelled', label: 'Cancelled' });
  });
  it('flags an undelivered order whose promised date has passed as at risk', () => {
    expect(chipFor('Scheduled', { deliveryDate: '2026-09-01', today: '2026-09-12' })).toEqual({
      status: 'risk',
      label: 'Past due',
    });
    expect(chipFor('Delivered', { deliveryDate: '2026-09-01', today: '2026-09-12' }).status).toBe(
      'fulfilled',
    );
    expect(chipFor('Scheduled', { deliveryDate: '2026-09-12', today: '2026-09-12' }).status).toBe(
      'scheduled',
    );
  });
  it('falls back to a draft-toned chip for an unknown word', () => {
    expect(chipFor('Something new')).toEqual({ status: 'draft', label: 'Something new' });
  });
});

describe('dates', () => {
  it('formats a day string without timezone drift', () => {
    expect(fmtDay('2026-09-14')).toBe('Sep 14');
    expect(fmtDay(null)).toBe('—');
  });
  it('says how long ago an order was written', () => {
    const now = new Date('2026-09-12T18:00:00Z');
    expect(relativeDay('2026-09-12T09:00:00Z', now)).toBe('today');
    expect(relativeDay('2026-09-11T09:00:00Z', now)).toBe('yesterday');
    expect(relativeDay('2026-09-08T09:00:00Z', now)).toBe('4d ago');
  });
});
