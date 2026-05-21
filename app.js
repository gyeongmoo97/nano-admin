// 판매자 PWA - 탭별 라이센스 목록 + 승인/폐기 + Web Push.
// 탭:
//   - 대기: trial 발급 후 미승인. "승인" / "폐기" (영구 거부).
//   - 활성: 정식 활성화된 라이센스. "환불 폐기" (사후 폐기).
//   - 폐기: blocked/refunded. "차단 해제" 가능.

const STORAGE_KEY = 'nano-admin-config-v1';

const state = {
  apiBase: '',
  token: '',
  vapidPublicKey: '',
  currentTab: 'pending',
  counts: { pending: 0, active: 0, blocked: 0 },
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch {}
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
  const res = await fetch(state.apiBase + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

function showAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'flex';
  const apiInput = document.getElementById('api-input');
  if (state.apiBase) apiInput.value = state.apiBase;
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none';
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim();
  const apiBase = document.getElementById('api-input').value.trim().replace(/\/$/, '');
  if (!token || !apiBase) return toast('토큰과 API URL을 모두 입력하세요', true);

  state.token = token;
  state.apiBase = apiBase;

  try {
    const vapidRes = await fetch(apiBase + '/admin/vapid-public');
    const vapidData = await vapidRes.json();
    if (!vapidData.ok) throw new Error('VAPID 키 조회 실패');
    state.vapidPublicKey = vapidData.vapidPublicKey;

    await api('/admin/pending');
    saveConfig();
    hideAuthOverlay();
    await refreshAll();
  } catch (e) {
    toast('인증 실패: ' + e.message, true);
  }
});

document.getElementById('logout').addEventListener('click', () => {
  if (confirm('로그아웃하시겠습니까? 푸시 구독도 해제됩니다.')) {
    unsubscribePush().finally(() => {
      clearConfig();
      location.reload();
    });
  }
});

document.getElementById('refresh').addEventListener('click', () => refreshAll());
document.getElementById('enable-push').addEventListener('click', () => enablePush());

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
  await Promise.all([loadPending(), loadActive(), loadBlocked()]);
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

async function loadActive() {
  try {
    const data = await api('/admin/list?state=active');
    cache.active = data.licenses || [];
    state.counts.active = cache.active.length;
    document.getElementById('count-active').textContent = state.counts.active;
  } catch (e) {
    cache.active = { __error: e.message };
  }
}

async function loadBlocked() {
  try {
    const [b, r] = await Promise.all([
      api('/admin/list?state=blocked'),
      api('/admin/list?state=refunded'),
    ]);
    const merged = [...(b.licenses || []), ...(r.licenses || [])];
    merged.sort((a, b) => (b.blockedAt || b.createdAt) - (a.blockedAt || a.createdAt));
    cache.blocked = merged;
    state.counts.blocked = merged.length;
    document.getElementById('count-blocked').textContent = state.counts.blocked;
  } catch (e) {
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
  el.style.opacity = '0.5';
  try {
    await api('/admin/approve', {
      method: 'POST',
      body: JSON.stringify({ orderId }),
    });
    toast('승인 완료. 구매자는 다음 verify에서 자동 정식 전환됩니다.');
    el.remove();
    state.counts.pending = Math.max(0, state.counts.pending - 1);
    document.getElementById('count-pending').textContent = state.counts.pending;
    // 활성 탭은 stale - 다음 진입 시 재조회
    cache.active = null;
    if (!document.querySelector('.order')) renderCurrentTab();
  } catch (e) {
    toast('승인 실패: ' + e.message, true);
    el.style.opacity = '1';
  }
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
  // 쿼리로 받은 값 즉시 검증 후 저장
  autoLoginFromQuery();
} else if (!state.token || !state.apiBase) {
  showAuthOverlay();
} else {
  refreshAll();
}

async function autoLoginFromQuery() {
  try {
    // VAPID 키 조회 (인증 검증 + 로그인 확정)
    const vapidRes = await fetch(state.apiBase + '/admin/vapid-public');
    const vapidData = await vapidRes.json();
    if (vapidData.ok) state.vapidPublicKey = vapidData.vapidPublicKey;
    // 토큰 유효성 확인
    await api('/admin/pending');
    saveConfig();
    hideAuthOverlay();
    toast('자동 로그인 완료');
    await refreshAll();
  } catch (e) {
    toast('자동 로그인 실패: ' + e.message, true);
    showAuthOverlay();
  }
}
