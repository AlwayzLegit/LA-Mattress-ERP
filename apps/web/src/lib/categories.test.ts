import { describe, expect, it } from 'vitest';
import { categoryList, categoryOptions } from './categories';

const flat = [
  { id: 'm', parentId: null, name: 'Mattresses', position: 0 },
  { id: 'p', parentId: null, name: 'Pillows', position: 1 },
  { id: 'mh', parentId: 'm', name: 'Hybrid', position: 1 },
  { id: 'mi', parentId: 'm', name: 'Innerspring', position: 0 },
];

describe('categoryOptions', () => {
  it('walks the tree in position order and labels each option with its path', () => {
    expect(categoryOptions(flat).map((o) => `${o.depth}:${o.name}`)).toEqual([
      '0:Mattresses',
      '1:Mattresses › Innerspring',
      '1:Mattresses › Hybrid',
      '0:Pillows',
    ]);
  });

  it('reads both response shapes', () => {
    expect(categoryList(flat)).toHaveLength(4);
    expect(categoryList({ flat })).toHaveLength(4);
  });
});
