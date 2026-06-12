// 판매자 PWA - 탭별 라이센스 목록 + 승인/폐기 + Web Push.
// 탭:
//   - 대기: trial 발급 후 미승인. "승인" / "폐기" (영구 거부).
//   - 활성: 정식 활성화된 라이센스. "환불 폐기" (사후 폐기).
//   - 폐기: blocked/refunded. "차단 해제" 가능.

const STORAGE_KEY = 'nano-admin-config-v1';
// sessionStorage 사용 — 탭 닫으면 자동 폐기. localStorage보다 안전.
const SESSION_STORAGE_KEY = 'nano-admin-session-v1';

const state = {
  apiBase: '',
  token: '',
  vapidPublicKey: '',
  /** PIN 검증 후 받은 session token (sessionStorage 보관). 30분 TTL. */
  sessionId: '',
  /** session 만료 unix sec. 임박 시 UI 표시 가능. */
  sessionExpiresAt: 0,
  currentTab: 'pending',
  counts: { pending: 0, active: 0, blocked: 0 },
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch {}
  // session은 별도 (sessionStorage)
  try {
    const sraw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (sraw) {
      const s = JSON.parse(sraw);
      // 만료된 session은 무시
      if (s.sessionId && s.sessionExpiresAt > Math.floor(Date.now() / 1000)) {
        state.sessionId = s.sessionId;
        state.sessionExpiresAt = s.sessionExpiresAt;
      }
    }
  } catch {}
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      sessionId: state.sessionId,
      sessionExpiresAt: state.sessionExpiresAt,
    }));
  } catch {}
}

function clearSession() {
  state.sessionId = '';
  state.sessionExpiresAt = 0;
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
}

/**
 * URL 쿼리파라미터로 자동 로그인.
 * 예: https://.../nano-admin/?token=ABC123&api=https://x.deno.net
 *
 * 보안:
 * - URL은 브라우저 히스토리/캐시에 남으므로, 파라미터를 발견하면 즉시
 *   localStorage에 저장하고 history.replaceState로 URL을 정리 (토큰 잔존 방지).
 * - 휴대폰 화면 캡처/공유 시 토큰이 노출되지 않도록 사용 후엔 URL 깨끗.
 */
function loadFromQuery() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  const api = params.get('api') || params.get('apiBase');
  if (!token && !api) return false;
  if (token) state.token = token;
  if (api) state.apiBase = api.replace(/\/$/, '');
  // URL 즉시 정리 - history에 토큰이 안 남도록.
  try {
    history.replaceState({}, '', location.pathname);
  } catch {}
  return Boolean(token && state.apiBase);
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    apiBase: state.apiBase,
    token: state.token,
    vapidPublicKey: state.vapidPublicKey,
  }));
}

function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
  state.apiBase = '';
  state.token = '';
  state.vapidPublicKey = '';
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
    ...(options.headers || {}),
  };
  if (state.sessionId) headers['X-Admin-Session'] = state.sessionId;

  const res = await fetch(state.apiBase + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  // PIN session 만료/누락 → PIN 재입력 유도. throw하지 않고 promise reject로 분리.
  if (res.status === 401 && (data.error === 'PIN_REQUIRED' || data.error === 'SESSION_EXPIRED')) {
    clearSession();
    showAuthOverlay({ step: 'pin', notice: data.message || 'PIN을 다시 입력해주세요' });
    throw new Error(data.message || 'PIN 재인증 필요');
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Auth overlay 표시. step="token"이면 토큰 입력 단계, "pin"이면 PIN 단계.
 * notice는 PIN 화면 상단에 표시 (예: "session 만료" 메시지).
 */
function showAuthOverlay({ step = 'token', notice = '' } = {}) {
  document.getElementById('auth-overlay').style.display = 'flex';
  const apiInput = document.getElementById('api-input');
  if (state.apiBase) apiInput.value = state.apiBase;

  const tokenSection = document.getElementById('auth-step-token');
  const pinSection = document.getElementById('auth-step-pin');
  if (step === 'pin') {
    tokenSection.style.display = 'none';
    pinSection.style.display = 'block';
    const pinResult = document.getElementById('pin-result');
    if (notice) {
      pinResult.innerHTML = `<span style="color:var(--warn)">${escapeHtml(notice)}</span>`;
    } else {
      pinResult.innerHTML = '';
    }
    setTimeout(() => document.getElementById('pin-input')?.focus(), 100);
  } else {
    tokenSection.style.display = 'block';
    pinSection.style.display = 'none';
  }
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none';
}

/**
 * 토큰 검증 통과 후 호출 — PIN 단계로 이동.
 * 이미 유효한 session이 sessionStorage에 있으면 바로 본 UI로.
 */
async function proceedAfterToken() {
  saveConfig();
  if (state.sessionId && state.sessionExpiresAt > Math.floor(Date.now() / 1000)) {
    // 유효 session 잔존 — 바로 본 UI
    hideAuthOverlay();
    await refreshAll();
    return;
  }
  showAuthOverlay({ step: 'pin' });
}

/**
 * PIN 입력 → POST /admin/session → sessionId 받기.
 * 실패 시 남은 시도 횟수 표시. 5회 초과 시 lockout.
 */
async function submitPin() {
  const pinInput = document.getElementById('pin-input');
  const pin = pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    document.getElementById('pin-result').innerHTML =
      '<span style="color:var(--error)">6자리 숫자만 입력 가능합니다</span>';
    return;
  }

  const btn = document.getElementById('pin-submit-btn');
  btn.disabled = true;
  btn.textContent = '확인 중...';
  document.getElementById('pin-result').innerHTML = '';

  try {
    const res = await fetch(state.apiBase + '/admin/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
      state.sessionId = data.sessionId;
      state.sessionExpiresAt = data.expiresAt;
      saveSession();
      pinInput.value = '';
      hideAuthOverlay();
      await refreshAll();
      return;
    }

    // 실패 처리
    if (data.error === 'PIN_RATE_LIMITED') {
      document.getElementById('pin-result').innerHTML =
        `<span style="color:var(--error)">${escapeHtml(data.message || 'PIN 입력 5회 실패 — 1시간 차단')}</span>`;
    } else if (data.error === 'PIN_INVALID') {
      const remain = data.attemptsRemaining ?? '?';
      document.getElementById('pin-result').innerHTML =
        `<span style="color:var(--error)">PIN 불일치. 남은 시도 ${escapeHtml(remain)}회</span>`;
      pinInput.value = '';
      pinInput.focus();
    } else {
      document.getElementById('pin-result').innerHTML =
        `<span style="color:var(--error)">${escapeHtml(data.message || 'PIN 검증 실패')}</span>`;
    }
  } catch (e) {
    document.getElementById('pin-result').innerHTML =
      `<span style="color:var(--error)">네트워크 오류: ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '확인';
  }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim();
  const apiBase = document.getElementById('api-input').value.trim().replace(/\/$/, '');
  if (!token || !apiBase) return toast('토큰과 API URL을 모두 입력하세요', true);

  state.token = token;
  state.apiBase = apiBase;

  try {
    // 토큰 유효성 미리 확인 (Bearer만으로 VAPID public 호출 가능, PIN 불필요)
    const vapidRes = await fetch(apiBase + '/admin/vapid-public');
    const vapidData = await vapidRes.json();
    if (!vapidData.ok) throw new Error('VAPID 키 조회 실패 (URL 확인)');
    state.vapidPublicKey = vapidData.vapidPublicKey;

    // Bearer 검증 — vapid-public는 Bearer 없이도 통과하므로 별도 확인 필요.
    // /admin/session 진입은 Bearer만 검증하므로 PIN 입력 화면을 띄우면 자동으로 Bearer도 검증됨.
    await proceedAfterToken();
  } catch (e) {
    toast('1단계 인증 실패: ' + e.message, true);
  }
});

document.getElementById('pin-submit-btn').addEventListener('click', () => submitPin());
document.getElementById('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPin();
});
// 6자리 입력 자동 제출 — 휴대폰 UX
document.getElementById('pin-input').addEventListener('input', (e) => {
  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = v;
  if (v.length === 6) submitPin();
});
document.getElementById('pin-back-btn').addEventListener('click', () => {
  showAuthOverlay({ step: 'token' });
});

document.getElementById('logout').addEventListener('click', async () => {
  if (!confirm('로그아웃하시겠습니까? 푸시 구독도 해제됩니다.')) return;
  // session 명시적 폐기 (Bearer + Session 둘 다 있는 시점에 호출)
  try {
    if (state.sessionId) {
      await fetch(state.apiBase + '/admin/session/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.token}`,
          'X-Admin-Session': state.sessionId,
        },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
    }
  } catch {}
  await unsubscribePush().catch(() => {});
  clearSession();
  clearConfig();
  location.reload();
});

document.getElementById('refresh').addEventListener('click', () => refreshAll());
document.getElementById('enable-push').addEventListener('click', () => enablePush());
document.getElementById('backup-csv').addEventListener('click', () => downloadKeysCsv({ manual: true }));

// 탭 전환
document.getElementById('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.currentTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el === t));
  renderCurrentTab();
});

let cache = { pending: null, active: null, blocked: null };

async function refreshAll() {
  // 이전엔 pending + active + blocked + refunded 4개 동시 호출 → 서버에서 같은 prefix 4번 풀스캔.
  // 지금은 /admin/list?state=all 1회로 모든 라이센스를 받아 클라에서 분할 → 1회 풀스캔.
  await Promise.all([loadPending(), loadActiveAndBlocked()]);
  await updatePushStatus();
  renderCurrentTab();
}

async function loadPending() {
  try {
    const data = await api('/admin/pending');
    cache.pending = data.pending || [];
    state.counts.pending = cache.pending.length;
    document.getElementById('count-pending').textContent = state.counts.pending;
  } catch (e) {
    cache.pending = { __error: e.message };
  }
}

/**
 * 한 번의 GET /admin/list?state=all 호출로 active/blocked/refunded 모두 받아
 * 클라이언트에서 분할. Deno KV 풀스캔 4회 → 1회로 압축.
 */
async function loadActiveAndBlocked() {
  try {
    const data = await api('/admin/list?state=all');
    const all = data.licenses || [];
    cache.active = all.filter((l) => l.state === 'active');
    const blockedMerged = all.filter((l) => l.state === 'blocked' || l.state === 'refunded');
    blockedMerged.sort((a, b) => (b.blockedAt || b.createdAt) - (a.blockedAt || a.createdAt));
    cache.blocked = blockedMerged;

    state.counts.active = cache.active.length;
    state.counts.blocked = cache.blocked.length;
    document.getElementById('count-active').textContent = state.counts.active;
    document.getElementById('count-blocked').textContent = state.counts.blocked;
  } catch (e) {
    cache.active = { __error: e.message };
    cache.blocked = { __error: e.message };
  }
}

function renderCurrentTab() {
  const main = document.getElementById('main');
  const data = cache[state.currentTab];
  if (data === null) {
    main.innerHTML = '<div class="empty">불러오는 중...</div>';
    return;
  }
  if (data && data.__error) {
    main.innerHTML = `<div class="empty" style="color:var(--error)">${escapeHtml(data.__error)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    const msg = {
      pending: '대기 중인 클레임이 없습니다 ✓',
      active: '활성 라이센스가 없습니다',
      blocked: '폐기된 라이센스가 없습니다',
    }[state.currentTab];
    main.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  if (state.currentTab === 'pending') renderPending(main, data);
  else if (state.currentTab === 'active') renderActive(main, data);
  else renderBlocked(main, data);
}

function renderPending(main, pending) {
  main.innerHTML = pending.map((p) => `
    <div class="order" data-order-id="${escapeHtml(p.orderId)}">
      <div class="order-head">
        <span class="badge ${p.channel}">${labelChannel(p.channel)}</span>
        <span style="font-size:11px;color:var(--muted)">${timeAgo(p.createdAt)}</span>
      </div>
      <div class="order-id">${escapeHtml(p.orderId)}</div>
      ${p.siteNickname ? `<div class="meta"><strong>닉네임</strong> ${escapeHtml(p.siteNickname)}</div>` : ''}
      <div class="meta"><strong>이메일</strong> ${escapeHtml(p.email)}</div>
      ${p.note ? `<div class="meta"><strong>메모</strong> ${escapeHtml(p.note)}</div>` : ''}
      <div class="meta" style="font-family:monospace;font-size:11px">${escapeHtml(p.licenseKey)}</div>
      <div class="actions">
        <button class="btn primary" data-action="approve">승인</button>
        <button class="btn danger" data-action="discard">폐기</button>
      </div>
    </div>
  `).join('');

  main.querySelectorAll('.order').forEach((el) => {
    const orderId = el.dataset.orderId;
    el.querySelector('[data-action="approve"]').addEventListener('click', () => approveOrder(orderId, el));
    el.querySelector('[data-action="discard"]').addEventListener('click', () => discardPending(orderId, el));
  });
}

function renderActive(main, licenses) {
  main.innerHTML = licenses.map((l) => `
    <div class="order" data-license-key="${escapeHtml(l.key)}">
      <div class="order-head">
        <span class="state-pill active">활성</span>
        <span style="font-size:11px;color:var(--muted)">승인: ${timeAgo(l.approvedAt || l.createdAt)}</span>
      </div>
      <div class="order-id" style="font-size:13px">${escapeHtml(l.key)}</div>
      <div class="meta"><strong>주문</strong> ${escapeHtml(l.orderId)} · <strong>이메일</strong> ${escapeHtml(l.email)}</div>
      ${l.siteNickname ? `<div class="meta"><strong>닉네임</strong> ${escapeHtml(l.siteNickname)}</div>` : ''}
      ${l.approveNote ? `<div class="meta"><strong>승인 메모</strong> ${escapeHtml(l.approveNote)}</div>` : ''}
      <div class="meta">디바이스 ${l.deviceCount}대${l.devices.length > 0 ? ' (' + l.devices.map(d => escapeHtml(d.label)).join(', ') + ')' : ''}</div>
      <div class="actions">
        <button class="btn danger" data-action="refund">환불 폐기</button>
      </div>
    </div>
  `).join('');

  main.querySelectorAll('.order').forEach((el) => {
    const key = el.dataset.licenseKey;
    el.querySelector('[data-action="refund"]').addEventListener('click', () => refundLicense(key, el));
  });
}

function renderBlocked(main, licenses) {
  main.innerHTML = licenses.map((l) => `
    <div class="order" data-license-key="${escapeHtml(l.key)}">
      <div class="order-head">
        <span class="state-pill ${l.state}">${l.state === 'refunded' ? '환불' : '차단'}</span>
        <span style="font-size:11px;color:var(--muted)">${l.blockedAt ? timeAgo(l.blockedAt) : '-'}</span>
      </div>
      <div class="order-id" style="font-size:13px">${escapeHtml(l.key)}</div>
      <div class="meta"><strong>주문</strong> ${escapeHtml(l.orderId)} · <strong>이메일</strong> ${escapeHtml(l.email)}</div>
      ${l.blockedReason ? `<div class="meta"><strong>사유</strong> ${escapeHtml(l.blockedReason)}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-action="unblock" style="background:transparent;border:1px solid var(--border);color:var(--text)">차단 해제</button>
      </div>
    </div>
  `).join('');

  main.querySelectorAll('.order').forEach((el) => {
    const key = el.dataset.licenseKey;
    el.querySelector('[data-action="unblock"]').addEventListener('click', () => unblockLicense(key, el));
  });
}

// ── 액션 ──

async function approveOrder(orderId, el) {
  // 승인 메모 입력 (선택). prompt()는 PWA에서 차단되는 경우가 있어 인라인 모달 사용.
  const approveNote = await askApproveNote(orderId);
  if (approveNote === null) return; // 사용자가 취소

  el.style.opacity = '0.5';
  try {
    await api('/admin/approve', {
      method: 'POST',
      body: JSON.stringify({ orderId, approveNote }),
    });
    toast('승인 완료. 구매자는 다음 verify에서 자동 정식 전환됩니다.');
    el.remove();
    state.counts.pending = Math.max(0, state.counts.pending - 1);
    document.getElementById('count-pending').textContent = state.counts.pending;
    // 활성 탭은 stale - 다음 진입 시 재조회
    cache.active = null;
    if (!document.querySelector('.order')) renderCurrentTab();

    // 키 발급 시점에 자동 백업 — DB 사고 시 복구 안전망.
    // 실패해도 approve 자체는 성공이므로 조용히 로그만.
    downloadKeysCsv({ manual: false }).catch((err) => {
      console.warn('[backup] CSV 자동 다운로드 실패:', err);
    });
  } catch (e) {
    toast('승인 실패: ' + e.message, true);
    el.style.opacity = '1';
  }
}

/**
 * 승인 메모 입력 모달. 빈 값도 허용 (메모 없이 그냥 승인).
 * @returns 메모 string 또는 null (취소)
 */
function askApproveNote(orderId) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;' +
      'align-items:center;justify-content:center;z-index:300;padding:24px';
    overlay.innerHTML = `
      <div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;
                  padding:20px;width:100%;max-width:420px">
        <h2 style="margin:0 0 8px;font-size:16px">승인 메모 (선택)</h2>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px">
          주문 ${escapeHtml(orderId)} 승인 시 본인용으로 남길 메모입니다. 비워둬도 됩니다.
        </div>
        <textarea id="approve-note-input" placeholder="예: 환불 보장 약속, 강의 수강생, 특이사항 등"
                  style="width:100%;min-height:80px;padding:10px;background:var(--bg);
                         color:var(--text);border:1px solid var(--border);border-radius:6px;
                         font-family:inherit;font-size:13px;resize:vertical" maxlength="500"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="approve-cancel"
                  style="flex:1;padding:10px;background:transparent;border:1px solid var(--border);
                         color:var(--muted);border-radius:6px;font-size:13px;cursor:pointer">
            취소
          </button>
          <button id="approve-ok"
                  style="flex:1;padding:10px;background:var(--accent);color:white;border:none;
                         border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">
            승인 확정
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#approve-note-input');
    setTimeout(() => input.focus(), 100);

    const close = (val) => {
      document.body.removeChild(overlay);
      resolve(val);
    };
    overlay.querySelector('#approve-cancel').onclick = () => close(null);
    overlay.querySelector('#approve-ok').onclick = () => close(input.value.trim());
    // 빠른 승인: Ctrl/Cmd+Enter, 취소: Esc
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });
  });
}

async function discardPending(orderId, el) {
  const reason = prompt('폐기 사유 (선택, 라이센스가 영구 차단됩니다):') ?? '';
  if (!confirm(`주문 ${orderId} 를 영구 폐기하시겠습니까?\n→ 발급된 trial 라이센스도 즉시 무효화됩니다.`)) return;
  el.style.opacity = '0.5';
  try {
    await api('/admin/reject', {
      method: 'POST',
      body: JSON.stringify({ orderId, reason }),
    });
    toast('폐기 처리됨');
    el.remove();
    state.counts.pending = Math.max(0, state.counts.pending - 1);
    document.getElementById('count-pending').textContent = state.counts.pending;
    cache.blocked = null;
    if (!document.querySelector('.order')) renderCurrentTab();
  } catch (e) {
    toast('폐기 실패: ' + e.message, true);
    el.style.opacity = '1';
  }
}

async function refundLicense(licenseKey, el) {
  const reason = prompt('환불 사유 (필수):') ?? '';
  if (!reason.trim()) return toast('사유를 입력해주세요', true);
  if (!confirm(`라이센스 ${licenseKey} 를 환불 폐기하시겠습니까?\n→ 사용자 앱이 다음 verify에서 즉시 차단됩니다.`)) return;
  el.style.opacity = '0.5';
  try {
    await api('/admin/block', {
      method: 'POST',
      body: JSON.stringify({ licenseKey, reason, refunded: true }),
    });
    toast('환불 폐기 완료');
    el.remove();
    state.counts.active = Math.max(0, state.counts.active - 1);
    document.getElementById('count-active').textContent = state.counts.active;
    cache.blocked = null;
    if (!document.querySelector('.order')) renderCurrentTab();
  } catch (e) {
    toast('폐기 실패: ' + e.message, true);
    el.style.opacity = '1';
  }
}

async function unblockLicense(licenseKey, el) {
  if (!confirm(`라이센스 ${licenseKey} 의 차단을 해제하시겠습니까?`)) return;
  el.style.opacity = '0.5';
  try {
    await api('/admin/unblock', {
      method: 'POST',
      body: JSON.stringify({ licenseKey }),
    });
    toast('차단 해제됨');
    el.remove();
    state.counts.blocked = Math.max(0, state.counts.blocked - 1);
    document.getElementById('count-blocked').textContent = state.counts.blocked;
    cache.active = null;
    cache.pending = null;
    if (!document.querySelector('.order')) renderCurrentTab();
  } catch (e) {
    toast('해제 실패: ' + e.message, true);
    el.style.opacity = '1';
  }
}

// ── 백업 다운로드 ──

/**
 * /admin/keys.csv를 받아 브라우저 다운로드 트리거.
 * approve 직후 자동 호출 (manual=false) + 헤더 "백업" 버튼 클릭 시 (manual=true).
 *
 * manual=true: toast로 결과 알림.
 * manual=false: 성공만 조용히 toast, 실패는 console.warn (호출자가 catch).
 *
 * 파일명은 서버 Content-Disposition을 우선, 없으면 클라이언트에서 생성.
 */
async function downloadKeysCsv({ manual }) {
  // keys.csv는 PII 포함이라 서버에서 PIN session 필수 — 세션 헤더 동봉.
  const csvHeaders = { Authorization: `Bearer ${state.token}` };
  if (state.sessionId) csvHeaders['X-Admin-Session'] = state.sessionId;
  const res = await fetch(state.apiBase + '/admin/keys.csv', {
    headers: csvHeaders,
  });
  if (!res.ok) {
    if (manual) toast(`CSV 다운로드 실패: HTTP ${res.status}`, true);
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();

  // Content-Disposition 파싱: attachment; filename="licenses-...csv"
  let filename = null;
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) filename = decodeURIComponent(m[1]);
  if (!filename) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filename = `licenses-${ts}.csv`;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  // KB 단위로 크기 보고
  const kb = (blob.size / 1024).toFixed(1);
  if (manual) {
    toast(`🗂 백업 저장됨: ${filename} (${kb} KB)`);
  } else {
    toast(`🗂 키 백업 자동 저장: ${filename} (${kb} KB)`);
  }
  return filename;
}

// ── Web Push ──

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast('이 브라우저는 Web Push를 지원하지 않습니다', true);
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('알림 권한이 거부되었습니다', true);

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey),
    });

    const json = sub.toJSON();
    await api('/admin/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        subscriptionId: hashEndpoint(json.endpoint),
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
    toast('알림이 활성화되었습니다');
    await updatePushStatus();
  } catch (e) {
    toast('알림 설정 실패: ' + e.message, true);
  }
}

async function unsubscribePush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const json = sub.toJSON();
      await api('/admin/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId: hashEndpoint(json.endpoint) }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
}

async function updatePushStatus() {
  const dot = document.getElementById('push-dot');
  const label = document.getElementById('push-label');
  if (!('serviceWorker' in navigator)) {
    dot.className = 'status-dot bad';
    label.textContent = '브라우저 미지원';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      dot.className = 'status-dot ok';
      label.textContent = '알림 활성';
    } else {
      dot.className = 'status-dot';
      label.textContent = '알림 미설정';
    }
  } catch {
    dot.className = 'status-dot bad';
    label.textContent = '오류';
  }
}

// ── 유틸 ──

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function hashEndpoint(endpoint) {
  let h = 0;
  for (let i = 0; i < endpoint.length; i++) h = ((h << 5) - h + endpoint.charCodeAt(i)) | 0;
  return 'sub-' + (h >>> 0).toString(36);
}

function labelChannel(c) {
  return { kmong: '크몽', lecture: '강의', other: '기타' }[c] || c;
}

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000 - unixSec);
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function toast(msg, isError = false) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// 부트
loadConfig();
const fromQuery = loadFromQuery();
if (fromQuery) {
  autoLoginFromQuery();
} else if (!state.token || !state.apiBase) {
  showAuthOverlay({ step: 'token' });
} else if (!state.sessionId || state.sessionExpiresAt <= Math.floor(Date.now() / 1000)) {
  // 토큰은 있지만 PIN session이 없거나 만료 → PIN 단계
  showAuthOverlay({ step: 'pin' });
} else {
  // 모두 유효 — 바로 본 UI. session이 server에서 사라졌다면 첫 api() 호출에서 401 받고 PIN 단계로.
  refreshAll();
}

async function autoLoginFromQuery() {
  try {
    const vapidRes = await fetch(state.apiBase + '/admin/vapid-public');
    const vapidData = await vapidRes.json();
    if (vapidData.ok) state.vapidPublicKey = vapidData.vapidPublicKey;
    saveConfig();
    toast('자동 로그인 — PIN 입력 필요');
    showAuthOverlay({ step: 'pin' });
  } catch (e) {
    toast('자동 로그인 실패: ' + e.message, true);
    showAuthOverlay({ step: 'token' });
  }
}
