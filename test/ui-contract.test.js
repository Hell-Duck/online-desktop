const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('board exposes mouse controls for shared history and zoom', () => {
  for (const id of ['undoBtn', 'redoBtn', 'zoomLabel']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /id=["']undoBtn["'][^>]*>[^<]*Отменить/);
  assert.match(html, /id=["']redoBtn["'][^>]*>[^<]*Повторить/);
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
