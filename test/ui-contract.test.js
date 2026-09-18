const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('board exposes mouse controls for shared history and zoom', () => {
  for (const id of ['undoBtn', 'redoBtn', 'zoomLabel']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /id=["']undoBtn["'][^>]*>[\s\S]*?Отменить[\s\S]*?<\/button>/);
  assert.match(html, /id=["']redoBtn["'][^>]*>[\s\S]*?Повторить[\s\S]*?<\/button>/);
});

test('persistent palette offers common colors and a custom color input', () => {
  assert.match(html, /id=["']colorPalette["']/);
  assert.match(html, /id=["']customColor["']/);
  const swatches = html.match(/data-color=["']#[0-9a-fA-F]{6}["']/g) || [];
  assert.ok(swatches.length >= 8, `expected at least 8 swatches, found ${swatches.length}`);
});

test('board utilities load before the client', () => {
  const utilsAt = html.indexOf('/board-utils.js');
  const clientAt = html.indexOf('/client.js');
  assert.ok(utilsAt >= 0 && clientAt > utilsAt);
});

test('interface exposes the green collaborative visual theme', () => {
  for (const token of ['--accent:', '--accent-soft:', '--secondary:', '--panel-shadow:']) {
    assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /class=["']brand-mark["']/);
  assert.match(html, /class=["']tool-group/);
  assert.match(html, /class=["']palette-label["']/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
});

test('board keeps room presence visible and removes redundant controls', () => {
  assert.match(html, /class=["'][^"']*room-status[^"']*["']/);
  assert.match(html, /id=["']roomLabel["']/);
  assert.match(html, /id=["']peerCount["']/);
  assert.doesNotMatch(html, /id=["']findBtn["']/);
  assert.doesNotMatch(html, /id=["']deleteBtn["']/);
});

test('board controls use a consistent inline icon system', () => {
  const icons = html.match(/<svg[^>]*class=["'][^"']*icon[^"']*["']/g) || [];
  assert.ok(icons.length >= 12, `expected at least 12 inline icons, found ${icons.length}`);
});
