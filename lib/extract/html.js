'use strict';
// HTML to text. Tags are stripped; script and style are dropped. Nothing is rendered or executed.
const { MAX_CHARS } = require('./text');

function decode(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => {
    const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
  });
}

function toText(html) {
  let s = String(html).slice(0, 5 * 1048576);
  if (/<!ENTITY/i.test(s)) return { text: '', truncated: false, error: 'html_entity' };
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = s.length > MAX_CHARS;
  if (truncated) s = s.slice(0, MAX_CHARS);
  return { text: s, truncated };
}

function looksLikeHtml(text, name = '') {
  if (/\.html?$/i.test(name)) return true;
  const t = String(text).slice(0, 2000).trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.startsWith('<head') || t.startsWith('<body');
}

module.exports = { toText, looksLikeHtml };
