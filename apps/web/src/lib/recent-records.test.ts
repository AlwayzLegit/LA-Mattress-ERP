import { describe, expect, it } from 'vitest';
import { pushRef, refFromPath } from './recent-records';

const ID = '8bf7d49f-e907-4ad6-ac1b-df8b74d3b86a';

describe('recent records', () => {
  it('maps record pages to refs and ignores everything else', () => {
    expect(refFromPath(`/orders/${ID}`)).toBe(`order:${ID}`);
    expect(refFromPath(`/orders/${ID}/full`)).toBe(`order:${ID}`);
    expect(refFromPath(`/customers/${ID.toUpperCase()}`)).toBe(`customer:${ID}`);
    expect(refFromPath(`/purchase-orders/${ID}`)).toBe(`po:${ID}`);
    expect(refFromPath('/products/new')).toBeNull();
    expect(refFromPath('/orders')).toBeNull();
    expect(refFromPath('/dashboard')).toBeNull();
  });

  it('keeps the newest first, once each, capped', () => {
    const list = pushRef(pushRef(pushRef([], 'order:a'), 'customer:b'), 'order:a');
    expect(list).toEqual(['order:a', 'customer:b']);
    const many = Array.from({ length: 12 }, (_, i) => `order:${i}`).reduce<string[]>(
      (l, r) => pushRef(l, r),
      [],
    );
    expect(many).toHaveLength(8);
    expect(many[0]).toBe('order:11');
  });
});
