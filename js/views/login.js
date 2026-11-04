// 로그인: honor-system name + student number, kept on this device. Also the CRT switch.
import * as api from '../api.js';
import { h, icon, errorText } from '../ui.js';

export function loginView(app, { reason = '' } = {}) {
  const saved = { name: api.prefs.get('lastName', ''), sid: api.prefs.get('lastSid', '') };
  const name = h('input', { type: 'text', class: 'field', id: 'lg-name', autocomplete: 'name', maxlength: 80, value: saved.name, required: true });
  const sid = h('input', { type: 'text', class: 'field', id: 'lg-sid', autocomplete: 'off', inputmode: 'numeric', maxlength: 128, value: saved.sid, required: true });
  // Hidden door: an email in 이름 turns 학번 into a password field and logs in as admin.
  const isDoor = () => name.value.includes('@');
  function syncDoor() {
    const door = isDoor();
    if ((sid.type === 'password') === door) return;
    sid.type = door ? 'password' : 'text';
    sid.value = door ? '' : api.prefs.get('lastSid', '');
    sid.setAttribute('autocomplete', door ? 'current-password' : 'off');
    name.setAttribute('autocomplete', door ? 'username' : 'name');
    if (door) sid.removeAttribute('inputmode'); else sid.setAttribute('inputmode', 'numeric');
  }
  name.addEventListener('input', syncDoor);
  const msg = h('div', { role: 'alert' }, reason ? h('div', { class: 'notice warn' }, reason) : null);
  const crtOn = h('button', { type: 'button', 'aria-pressed': String(app.crt), onclick: () => setCrt(true) }, '켬');
  const crtOff = h('button', { type: 'button', 'aria-pressed': String(!app.crt), onclick: () => setCrt(false) }, '끔');
  function setCrt(v) {
    app.setCrt(v);
    crtOn.setAttribute('aria-pressed', String(v)); crtOff.setAttribute('aria-pressed', String(!v));
  }

  const form = h('form', { class: 'login', novalidate: true },
    h('div', { class: 'brand' }, icon('logo', 40),
      h('div', {}, h('div', { class: 'word' }, '연문회 OS'), h('div', { class: 'muted' }, '릴레이 소설 · 2026 가을'))),
    h('p', { style: 'margin:0' }, `한 사람이 한 줄씩 이어 써요. ${app.settings?.max_lines ?? 20}줄이 모이면 한 편이 완성돼요.`),
    msg,
    h('div', { class: 'label' }, h('label', { for: 'lg-name' }, '이름'), name),
    h('div', { class: 'label' }, h('label', { for: 'lg-sid' }, '학번'), sid),
    h('div', { class: 'row' }, h('span', { id: 'lg-crt' }, '화면 효과 (CRT)'),
      h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'lg-crt' }, crtOn, crtOff)),
    h('p', { class: 'muted', style: 'margin:0;line-height:18px' },
      (app.settings?.show_student_id ?? true)
        ? '이름과 학번은 쓴 줄과 함께 저장되고, 줄의 속성 창에서 보여요. 로그인은 이 기기에만 기억되고, 언제든 메뉴에서 로그아웃할 수 있어요.'
        : '이름과 학번은 쓴 줄과 함께 저장돼요. 다른 사람에게는 이름만 보여요. 로그인은 이 기기에만 기억되고, 언제든 메뉴에서 로그아웃할 수 있어요.'),
    h('div', { class: 'actions', style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap' },
      h('button', { type: 'button', class: 'btn', onclick: () => { api.setGuest(); app.afterLogin(); } }, '둘러보기 (읽기만)'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, '들어가기')));

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (isDoor()) {
      busy = true;
      try {
        await api.signIn(name.value.trim(), sid.value);
        if (!(await api.isAdmin())) { await api.signOut(); throw new api.ApiError('login_failed'); }
        sid.value = '';
        app.afterAdminLogin();
      } catch {
        msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: 'login_failed' })));
        sid.value = ''; sid.focus();
      } finally { busy = false; }
      return;
    }
    const ident = { name: api.cleanName(name.value), studentId: api.cleanStudentId(sid.value) };
    const problem = api.identityProblem(ident);
    if (problem) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, errorText({ code: problem })));
      (problem === 'invalid_name' ? name : sid).focus();
      return;
    }
    api.setIdentity(ident);
    api.prefs.set('lastName', ident.name); api.prefs.set('lastSid', ident.studentId);
    app.afterLogin();
  });

  const scroll = h('div', { class: 'win-scroll' }, form);
  const body = document.createDocumentFragment();
  body.append(scroll);
  return {
    type: 'login', route: '/login', title: '연문회 OS — 로그인', body,
    size: { w: 460, h: 500 }, position: 'center', remember: false, closable: false, resizable: false,
    className: 'login-win',
    mount() { setTimeout(() => (name.value ? sid : name).focus({ preventScroll: true }), 50); },
  };
}
