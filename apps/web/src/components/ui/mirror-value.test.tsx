import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MirrorValue } from './primitives';

/**
 * Owner 2026-09-21: the Descriptive card's read-only boxes looked like
 * text inputs, so people clicked in and typed with nothing happening. A
 * mirrored value must render as text — no input, no caret, no tab stop.
 */
describe('MirrorValue', () => {
  it('renders the value as plain text, never as a form control', () => {
    const html = renderToStaticMarkup(<MirrorValue value="BIA" />);
    expect(html).toContain('BIA');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('tabindex');
    expect(html).toContain('field-mirror');
  });

  it('shows an em dash when there is nothing to show', () => {
    for (const blank of ['', null, undefined]) {
      const html = renderToStaticMarkup(<MirrorValue value={blank} />);
      expect(html).toContain('—');
      expect(html).toContain('is-empty');
    }
  });

  it('takes a custom placeholder and keeps a zero visible', () => {
    expect(renderToStaticMarkup(<MirrorValue value="" empty="Mixed — see Variants" />)).toContain(
      'Mixed — see Variants',
    );
    const zero = renderToStaticMarkup(<MirrorValue value={0} />);
    expect(zero).toContain('0');
    expect(zero).not.toContain('is-empty');
  });
});
