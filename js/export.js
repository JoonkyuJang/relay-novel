import * as api from './api.js';
import { h, $, errorText } from './ui.js';

const storyId = new URLSearchParams(location.search).get('id');
const UNTITLED = '제목 없는 이야기';

const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const credit = (l) => !l.author_name ? '' : l.student_id ? `${l.author_name} (${l.student_id})` : l.author_name;

function storyArticle(s, i) {
  return h('article', { class: 'story', id: `s${i + 1}` },
    h('h2', {}, s.title || UNTITLED),
    h('p', { class: 'muted' }, `완결 ${fmtDate(s.completed_at)} · ${s.lines.length}줄`),
    s.lines.map(l => h('p', { class: 'line' },
      l.text, credit(l) ? [' ', h('span', { class: 'credit' }, `— ${credit(l)}`)] : null)));
}

function renderBook(data) {
  const { stories } = data;
  if (storyId) {
    document.title = `${stories[0].title || UNTITLED} · 릴레이 소설`;
    $('#back').href = `story.html?id=${storyId}`;
    $('#back').textContent = '← 이야기로';
    return [storyArticle(stories[0], 0)];
  }
  document.title = `릴레이 소설 모음 ${fmtDate(data.exported_at)}`;
  if (!stories.length) return [h('p', {}, '아직 완결된 이야기가 없어요.')];
  return [
    h('section', { class: 'cover' },
      h('h1', {}, '릴레이 소설 모음'),
      h('p', {}, `완결된 이야기 ${stories.length}편`),
      h('p', { class: 'muted' }, `${fmtDate(data.exported_at)} 기준`)),
    h('nav', { class: 'toc' },
      h('h2', {}, '차례'),
      h('ol', {}, stories.map((s, i) => h('li', {},
        h('a', { href: `#s${i + 1}` }, s.title || UNTITLED),
        h('span', { class: 'muted' }, ` · ${fmtDate(s.completed_at)}`))))),
    stories.map(storyArticle),
  ];
}

function toText(data) {
  const out = [];
  const { stories } = data;
  if (!storyId) {
    out.push('릴레이 소설 모음', `완결된 이야기 ${stories.length}편 · ${fmtDate(data.exported_at)} 기준`, '');
    stories.forEach((s, i) => out.push(`${i + 1}. ${s.title || UNTITLED}`));
    out.push('');
  }
  stories.forEach((s, i) => {
    out.push('='.repeat(40), storyId ? (s.title || UNTITLED) : `${i + 1}. ${s.title || UNTITLED}`,
      `완결 ${fmtDate(s.completed_at)} · ${s.lines.length}줄`, '');
    s.lines.forEach(l => out.push(credit(l) ? `${l.text}  — ${credit(l)}` : l.text));
    out.push('');
  });
  return out.join('\n');
}

function download(text, name) {
  const blob = new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' });   // BOM: Korean-safe in older Windows apps
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

try {
  const data = await api.exportStories(storyId);
  $('#book').replaceChildren(...renderBook(data).flat());
  $('#print').disabled = false;
  $('#txt').disabled = !data.stories.length;
  $('#print').addEventListener('click', () => window.print());
  $('#txt').addEventListener('click', () => {
    const base = storyId ? safeName(data.stories[0].title || 'story') : 'relay-novel';
    download(toText(data), `${base}-${fmtDate(data.exported_at).replaceAll('.', '')}.txt`);
  });
} catch (e) {
  $('#book').replaceChildren();
  $('#notice').replaceChildren(h('div', { class: 'box bad' }, errorText(e)));
}
