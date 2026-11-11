import { describe, expect, it } from 'vitest';
import { likePattern, prefixTsQuery, searchWords } from './product-search';

describe('catalog search words', () => {
  it('splits a query into lower-cased letter/digit runs', () => {
    expect(searchWords('  UNIVER  Blk ')).toEqual(['univer', 'blk']);
    expect(searchWords('8246-3/3')).toEqual(['8246', '3', '3']);
    expect(searchWords('tempur-pedic 5"')).toEqual(['tempur', 'pedic', '5']);
  });

  it('keeps at most eight words and drops punctuation-only queries', () => {
    expect(searchWords('a b c d e f g h i j')).toHaveLength(8);
    expect(searchWords('--- / "')).toEqual([]);
    expect(prefixTsQuery('--- / "')).toBeNull();
  });

  it('builds a prefix tsquery so a partly typed word matches', () => {
    const q = prefixTsQuery('univer blk');
    expect(q).not.toBeNull();
    expect(JSON.stringify(q)).toContain('univer:* & blk:*');
  });

  it('escapes LIKE wildcards in the substring pattern', () => {
    expect(likePattern(' 50%_off ')).toBe('%50\\%\\_off%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});
