// 오류 보고: uncaught errors in members' browsers go to 관리 · 기록 (message, where, browser —
// never names or 학번). At most 5 different errors per page load; the server throttles too.
import { logClientError } from '../api.js';
import { on } from './extras.js';

const seen = new Set();
const version = (() => {
  try { return new URL(document.querySelector('script[type="module"][src*="index.js"]')?.src ?? location.href).searchParams.get('v'); }
  catch { return null; }
})();

// noise we can't act on: other sites' scripts, browser extensions, benign browser warnings
const IGNORE = [/^Script error\.?$/, /ResizeObserver loop/, /extension:\/\//, /^Non-Error promise rejection/];

export function report(message, source = null, stack = null) {
  try {
    if (!on('error_reports') || seen.size >= 5) return;
    const msg = String(message ?? '').slice(0, 500);
    if (!msg || IGNORE.some(r => r.test(msg) || r.test(source ?? '') || r.test(stack ?? ''))) return;
    const key = `${msg}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    logClientError({ message: msg, source, stack: stack ? String(stack).slice(0, 2000) : null, version });
  } catch { /* never let the reporter throw */ }
}

export function initReports() {
  addEventListener('error', (e) => {
    if (!e.message) return;                       // resource load errors (img, font) have no message
    const where = e.filename ? `${e.filename.replace(location.origin, '').replace(/\?v=\w+/, '')}:${e.lineno}:${e.colno}` : null;
    report(e.message, where, e.error?.stack);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report(r?.message ?? String(r), 'promise', r?.stack);
  });
}
