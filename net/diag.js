// ASHEN OATH — проверка сети для режима «Интернет» (№2 [NET]), до создания комнаты.
// diagnoseInternet({ iceServers, peerHost }) → { server:'ok'|'fail', stun:'ok'|'relay'|'host-only'|'fail', verdict, lines[] }
//   server — отвечает ли сервер комнат PeerJS (облако 0.peerjs.com или свой);
//   stun   — ICE-кандидаты: srflx (внешний адрес через STUN) → прямое соединение скорее всего пройдёт;
//            relay → есть TURN; только host → UDP закрыт (школьный/офисный Wi-Fi) — нужна раздача с телефона или LAN.

async function withTimeout(p, ms, onTimeout) {
  let to;
  const t = new Promise((resolve) => { to = setTimeout(() => resolve(onTimeout), ms); });
  try { return await Promise.race([p, t]); } finally { clearTimeout(to); }
}

export async function checkPeerServer({ host = '0.peerjs.com', port = 443, secure = true, path = '/', key = 'peerjs' } = {}, ms = 5000) {
  const url = `${secure ? 'https' : 'http'}://${host}:${port}${path.endsWith('/') ? path : `${path}/`}${key}/id?ts=${Date.now()}${Math.random()}`;
  try {
    const r = await withTimeout(fetch(url, { cache: 'no-store' }), ms, null);
    return !!(r && r.ok);
  } catch (e) { return false; }
}

export async function checkStun(iceServers, ms = 3500) {
  if (typeof RTCPeerConnection === 'undefined') return 'fail';
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers });
    const kinds = new Set();
    const done = new Promise((resolve) => {
      pc.onicecandidate = (e) => {
        if (!e.candidate) { resolve(); return; }
        const m = / typ (host|srflx|prflx|relay)/.exec(e.candidate.candidate || '');
        if (m) kinds.add(m[1]);
        if (kinds.has('srflx') && (kinds.has('relay') || !iceServers.some((s) => String(s.urls).startsWith('turn')))) resolve();
      };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
    });
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await withTimeout(done, ms, null);
    if (kinds.has('srflx') || kinds.has('prflx')) return 'ok';
    if (kinds.has('relay')) return 'relay';
    return kinds.size ? 'host-only' : 'fail';
  } catch (e) {
    return 'fail';
  } finally {
    try { if (pc) pc.close(); } catch (e) { /* ignore */ }
  }
}

export async function diagnoseInternet({ iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], peer = null } = {}) {
  const [serverOk, stun] = await Promise.all([checkPeerServer(peer || undefined), checkStun(iceServers)]);
  const lines = [
    serverOk ? '✓ Сервер комнат PeerJS отвечает.' : '✗ Сервер комнат PeerJS не отвечает (нет интернета или его блокируют).',
    stun === 'ok' ? '✓ Внешний адрес (STUN) получен — прямое соединение скорее всего пройдёт.'
      : stun === 'relay' ? '✓ Есть только TURN-ретранслятор — соединение пройдёт через него.'
        : stun === 'host-only' ? '✗ UDP закрыт (STUN не отвечает) — сеть не пустит прямое соединение.'
          : '✗ WebRTC недоступен в этом браузере или сети.',
  ];
  const good = serverOk && (stun === 'ok' || stun === 'relay');
  const verdict = good ? 'Режим «Интернет» должен работать.'
    : 'Лучше раздать интернет с телефона (обоим ноутбукам) или включить LAN.';
  return { server: serverOk ? 'ok' : 'fail', stun, good, verdict, lines };
}
