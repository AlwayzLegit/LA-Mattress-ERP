import { describe, expect, it } from 'vitest';
import { buildCategoryIndex } from './category-tree';

const index = buildCategoryIndex([
  { id: 'm', parentId: null, name: 'Mattresses' },
  { id: 'mh', parentId: 'm', name: 'Hybrid' },
  { id: 'mhx', parentId: 'mh', name: 'Luxe' },
  { id: 'p', parentId: null, name: 'Pillows' },
]);

describe('buildCategoryIndex', () => {
  it('reads the full path from the root', () => {
    expect(index.pathOf('mhx')).toBe('Mattresses › Hybrid › Luxe');
    expect(index.pathOf('m')).toBe('Mattresses');
    expect(index.pathOf(null)).toBeNull();
    expect(index.pathOf('missing')).toBeNull();
  });

  it('lists a category with every descendant', () => {
    expect(index.treeIds('m').sort()).toEqual(['m', 'mh', 'mhx']);
    expect(index.treeIds('p')).toEqual(['p']);
  });

  it('walks the lineage leaf-first and names the root', () => {
    expect(index.lineageOf('mhx')).toEqual(['mhx', 'mh', 'm']);
    expect(index.lineageOf(undefined)).toEqual([]);
    expect(index.rootNameOf('mhx')).toBe('Mattresses');
    expect(index.rootNameOf('p')).toBe('Pillows');
    expect(index.rootNameOf(null)).toBeNull();
  });
});
