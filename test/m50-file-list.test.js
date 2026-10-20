'use strict';
// M50: pinned file lists are cleaned on create and when old rows are read (tasks #30-#32 stored "src/x.js;").
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cleanFileList } = require('../lib/file-list');

describe('M50 pinned file list', () => {
  it('drops trailing semicolons, quotes and ./, splits on ; , and newlines, de-duplicates', () => {
    assert.deepEqual(cleanFileList(['src/models/product.model.js;', 'src/controllers/book.controller.js;']), ['src/models/product.model.js', 'src/controllers/book.controller.js']);
    assert.deepEqual(cleanFileList('a.js; b.js,\n`c.js`\n./a.js'), ['a.js', 'b.js', 'c.js']);
    assert.deepEqual(cleanFileList(['"d.ts".', '', null]), ['d.ts']);
    assert.deepEqual(cleanFileList(['.env.example']), ['.env.example']);
  });
});
