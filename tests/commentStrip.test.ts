import { describe, expect, it } from 'vitest';

import { stripComments } from '../src/services/commentStrip';

describe('stripComments', () => {
  it('blanks out a block comment while preserving line/column positions', () => {
    const source = '/*\n * data-fm-theme="dark"\n */\nconst x = 1;';
    const stripped = stripComments(source);
    expect(stripped).not.toContain('data-fm-theme');
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped).toContain('const x = 1;');
  });

  it('blanks out a line comment but keeps the newline', () => {
    const source = '// setSidebarLinks(foo)\nreal();';
    const stripped = stripComments(source);
    expect(stripped).not.toContain('setSidebarLinks');
    expect(stripped).toContain('real();');
    expect(stripped.split('\n').length).toBe(2);
  });

  it('does not touch comment-like text inside a string literal', () => {
    const source = 'const s = "not // a comment /* either */";';
    const stripped = stripComments(source);
    expect(stripped).toContain('not // a comment /* either */');
  });

  it('leaves real code untouched outside comments', () => {
    const source = '<html data-fm-theme="dark"><body /></html>';
    expect(stripComments(source)).toBe(source);
  });

  it('with lineComments: false, does not treat // as a comment (CSS url())', () => {
    const source = '.app-x { background: url(http://example.com/x.png); }';
    const stripped = stripComments(source, { lineComments: false });
    expect(stripped).toBe(source);
  });

  it('still strips /* */ block comments when lineComments is false', () => {
    const source = '/* .fm-container { max-width: 880px; } */\n.app-y { color: red; }';
    const stripped = stripComments(source, { lineComments: false });
    expect(stripped).not.toContain('.fm-container');
    expect(stripped).toContain('.app-y');
  });
});
