// ==UserScript==
// @name         GeoFS Dogfight Combined (Radar + Weapons + PvP)
// @namespace    https://geo-fs.com/
// @version      1.2.0
// @description  Combat libre multijoueur GeoFS : radar, missiles, canon et modèles d'emports.
// @author       OpenAI + adaptations des addons fournis
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://beta.geo-fs.com/geofs.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // À REMPLACER après le déploiement Vercel.
  const WS_URL = 'wss://geofs-dogfight-addon.vercel.app/api/ws';
  const STORES_URL = 'https://raw.githubusercontent.com/OC135/GeoFs-weapon-addon/refs/heads/main/weapons-vehicles.js';
  const LAUNCH_SOUND = 'https://raw.githubusercontent.com/mxwl-mesh-glb/missile-launch/main/freesound_community-missile-firing-fl-106655.mp3';
  const PING_MS = 300;
  const STATE_MS = 300;
  const PLAYER_REFRESH_MS = 1200;

  const WEAPONS = [
    { name: 'AIM-9', counter: 'flares', label: 'AIM-9 Sidewinder' },
    { name: 'AIM-9C', counter: 'chaff', label: 'AIM-9C' },
    { name: 'AIM-120', counter: 'chaff', label: 'AIM-120 AMRAAM' },
    { name: 'R-27EA', counter: 'chaff', label: 'R-27EA' },
    { name: 'R-27R', counter: 'chaff', label: 'R-27R' },
    { name: 'R-27T', counter: 'flares', label: 'R-27T' },
    { name: 'R-33', counter: 'chaff', label: 'R-33' },
    { name: 'R-73', counter: 'flares', label: 'R-73' },
    { name: 'R-77', counter: 'chaff', label: 'R-77' },
  ];

  const DEFAULT_AMMO = {
    'AIM-9': 2, 'AIM-9C': 1, 'AIM-120': 2, 'AIM-54': 1,
    'R-27EA': 1, 'R-27R': 1, 'R-27T': 1, 'R-33': 1,
    'R-73': 2, 'R-77': 2,
  };

  const PYLON_MODELS = [
    ['F-15E', 'pf15e46.glb'], ['F-16C', 'pf16c18.glb'],
    ['A-10C', 'pa108.glb'], ['F/A-18F', 'pf18e8.glb'],
    ['Rafale M', 'prafale2.glb'], ['F-15C', 'pf15c1.glb'],
    ['Su-35', 'psu358.glb'], ['Mirage 2000-5', 'pm2001.glb'],
    ['Mirage 2000D/N', 'pm20d1.glb'], ['F-5F', 'pf5f3.glb'],
    ['F-15EX', 'pf15ex2.glb'], ['F-35B', 'pf35b4.glb'],
    ['B-2A', 'pb2a1.glb'], ['F-15D', 'pf15d1.glb'],
    ['F-2A', 'pf2a2.glb'], ['F-15J', 'pylonf15j1.glb'],
    ['T-4', 'T48.glb'], ['UH-1H', 'puh1h1.glb'],
    ['AC-182', 'pac1822.glb'], ['UH-60L', 'puh60l1.glb'],
    ['MQ-9B', 'pmq9b1.glb'], ['F-16D', 'pf16d1.glb'],
  ];

  const wait = setInterval(() => {
    if (window.geofs?.aircraft?.instance &&
        window.geofs?.api?.viewer &&
        window.Cesium) {
      clearInterval(wait);
      init();
    }
  }, 500);

  function init() {
    if (window.__GEOFS_DOGFIGHT_RUNNING__) return;
    window.__GEOFS_DOGFIGHT_RUNNING__ = true;

    const $ = (id) => document.getElementById(id);

    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem('geofs-dogfight-session') || '{}');
      } catch {
        return {};
      }
    })();

    const session = {
      id: saved.id || randomToken(20),
      token: saved.token || randomToken(32),
      room: saved.room || 'DOGFIGHT',
      callsign: saved.callsign || 'PILOT',
    };

    const state = {
      ws: null,
      connected: false,
      armed: false,
      autoCM: true,
      manualClose: false,
      players: [],
      targetId: null,
      hp: 100,
      flares: 12,
      chaff: 12,
      ammo: { ...DEFAULT_AMMO },
      weaponIndex: 0,
      gunTimer: null,
      lastGunVisual: 0,
      reconnectDelay: 1200,
      loopsStarted: false,
      incoming: null,
      stores: [],
      addedParts: new Set(),
      addedPylon: false,
      radarRangeIndex: 1,
      radarVisible: true,
    };

    function randomToken(n) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => chars[b % chars.length]).join('');
    }

    function notify(message, color = '#7dff9b') {
      const node = document.createElement('div');
      node.textContent = message;
      Object.assign(node.style, {
        position: 'fixed',
        left: '50%',
        top: '56px',
        transform: 'translateX(-50%)',
        zIndex: '1000002',
        color,
        background: 'rgba(0,0,0,.9)',
        border: `1px solid ${color}`,
        padding: '8px 14px',
        font: '12px monospace',
        pointerEvents: 'none',
      });
      document.body.appendChild(node);
      setTimeout(() => node.remove(), 2600);
    }

    function saveSession() {
      localStorage.setItem('geofs-dogfight-session', JSON.stringify(session));
    }

    function send(type, data = {}) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type, ...data }));
        return true;
      }
      return false;
    }

    function activeInput() {
      const tag = document.activeElement?.tagName;
      return tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        document.activeElement?.isContentEditable;
    }

    function ac() {
      return geofs.aircraft.instance;
    }

    function lla() {
      const a = ac().llaLocation || [0, 0, 0];
      return {
        lat: Number(a[0]) || 0,
        lon: Number(a[1]) || 0,
        alt: Number(a[2]) || 0,
      };
    }

    function heading() {
      return ((Number(ac().htr?.[0]) || 0) % 360 + 360) % 360;
    }

    function aircraftName() {
      return String(ac().name || ac().aircraftName || ac().id || 'GeoFS aircraft').slice(0, 80);
    }

    function selectedWeapon() {
      return WEAPONS[state.weaponIndex % WEAPONS.length];
    }

    function activeAmmo() {
      return Number(state.ammo[selectedWeapon().name] || 0);
    }

    function currentTarget() {
      return state.players.find(p => p.id === state.targetId);
    }

    function setStatus(text, color = '#aaa') {
      $('df-status').textContent = text;
      $('df-status').style.color = color;
    }

    function renderStatus() {
      $('df-hp').textContent = `${Math.max(0, Math.round(state.hp))}%`;
      $('df-hp').style.color = state.hp < 35 ? '#ff5555' : '#9affaa';
      $('df-ammo').textContent = `${selectedWeapon().name} × ${activeAmmo()}`;
      $('df-cm').textContent = `FLR ${state.flares} / CHAFF ${state.chaff}`;
      $('df-target').textContent = currentTarget()?.callsign || 'AUCUNE';
      $('df-arm').textContent = state.armed ? 'ARMEMENT : ON' : 'ARMEMENT : OFF';
      $('df-arm').style.color = state.armed ? '#ff5757' : '#9affaa';
      $('df-auto').textContent = `AUTO-LEURRES : ${state.autoCM ? 'ON' : 'OFF'}`;
      $('df-weapon-name').textContent = selectedWeapon().label;
      if ($('df-weapon')) $('df-weapon').value = selectedWeapon().name;
      $('df-players-count').textContent = `${state.players.length} PILOTE(S)`;
    }

    const panel = document.createElement('div');
    panel.id = 'geofs-dogfight-panel';

    panel.innerHTML = `
      <div class="df-head"><b>GEOFS // DOGFIGHT</b><button id="df-min">—</button></div>
      <div id="df-body">
        <div class="df-row"><span id="df-status">NON CONNECTÉ</span><span id="df-players-count">0 PILOTE(S)</span></div>
        <div class="df-grid">
          <label>Salon<input id="df-room" maxlength="24" value="${escapeHtml(session.room)}"></label>
          <label>Indicatif<input id="df-callsign" maxlength="24" value="${escapeHtml(session.callsign)}"></label>
        </div>
        <button id="df-connect" class="df-btn">REJOINDRE LE SALON</button>
        <div class="df-line"></div>
        <div class="df-row"><b id="df-arm">ARMEMENT : OFF</b><b>VIE <span id="df-hp">100%</span></b></div>
        <div class="df-row"><span>Arme</span><b id="df-weapon-name">AIM-9</b></div>
        <label>Choisir un missile<select id="df-weapon"></select></label>
        <div class="df-row"><span>Emport</span><b id="df-ammo">AIM-9 × 2</b></div>
        <div class="df-row"><span>Leurres</span><b id="df-cm">FLR 12 / CHAFF 12</b></div>
        <div class="df-row"><span>Cible</span><b id="df-target">AUCUNE</b></div>
        <button id="df-auto" class="df-btn df-muted">AUTO-LEURRES : ON</button>
        <div class="df-row"><b>CONTACTS DU SALON</b><button id="df-refresh" class="df-small">ACTUALISER</button></div>
        <select id="df-players" size="4"></select>
        <button id="df-select" class="df-btn">DÉFINIR COMME CIBLE</button>
        <small>Combat libre : tous les pilotes de ce salon sont ciblables.</small>
        <div class="df-line"></div>
        <details open><summary>Pylônes et emports visuels (addon 2)</summary>
          <label>Configuration de pylônes<select id="df-pylon-select"></select></label>
          <div class="df-grid"><button id="df-pylon-add" class="df-btn">CHARGER PYLÔNES</button><button id="df-pylon-remove" class="df-btn">RETIRER</button></div>
          <small id="df-pylon-status">Choisissez le kit correspondant à votre avion.</small>
          <div class="df-line"></div>
          <input id="df-store-search" placeholder="Rechercher : F-16, AIM-120, GBU-31…">
          <select id="df-store-list" size="5"></select>
          <div class="df-grid"><button id="df-store-add" class="df-btn">AJOUTER</button><button id="df-store-remove" class="df-btn">RETIRER TOUT</button></div>
          <small id="df-store-status">Chargement de la bibliothèque…</small>
        </details>
        <div class="df-foot">ENTRÉE : armement · W : arme · ESPACE : missile · D : canon · MAJ : leurres</div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      #geofs-dogfight-panel{position:fixed;right:14px;top:76px;width:300px;max-height:calc(100vh - 100px);overflow:auto;z-index:1000000;background:rgba(3,10,8,.96);color:#adffc0;border:1px solid #1f9a48;box-shadow:0 0 16px #001d0b;padding:10px;font:11px/1.45 Consolas,monospace}
      #geofs-dogfight-panel *{box-sizing:border-box}
      #geofs-dogfight-panel input,#geofs-dogfight-panel select{width:100%;background:#05170b;color:#b9ffc8;border:1px solid #286b3a;padding:5px;font:11px monospace;margin-top:3px}
      #geofs-dogfight-panel select option{padding:3px}
      #geofs-dogfight-panel button{cursor:pointer;color:#c6ffd1;background:#06230f;border:1px solid #268b43;padding:6px;font:10px monospace}
      #geofs-dogfight-panel .df-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;letter-spacing:1px;border-bottom:1px solid #1d6330;padding-bottom:7px;margin-bottom:8px}
      #geofs-dogfight-panel .df-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:6px 0}
      #geofs-dogfight-panel .df-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}
      #geofs-dogfight-panel .df-btn{width:100%;margin:3px 0}
      #geofs-dogfight-panel .df-muted{color:#ffff99;border-color:#777744}
      #geofs-dogfight-panel .df-danger{color:#ff9999;border-color:#963333}
      #geofs-dogfight-panel .df-small{padding:3px 6px}
      #geofs-dogfight-panel .df-line{border-top:1px solid #194e29;margin:9px 0}
      #geofs-dogfight-panel summary{cursor:pointer;color:#fff;margin:5px 0}
      #geofs-dogfight-panel .df-foot{color:#8ab89a;font-size:9px;margin-top:9px}
      #geofs-dogfight-panel small{color:#8fae98;display:block;margin-top:5px}
      #df-radar{position:fixed;left:16px;bottom:16px;width:370px;z-index:999990;background:#020b05;border:1px solid #1c7e39;padding:8px;color:#00e85b;font:10px monospace}
      #df-radar-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
      #df-radar canvas{width:100%;height:auto;display:block}
      #df-radar button{background:#001a09;color:#00e85b;border:1px solid #14612a;font:9px monospace;padding:3px 7px;cursor:pointer}
      #df-alert{position:fixed;top:18%;left:50%;transform:translateX(-50%);padding:12px 18px;background:rgba(80,0,0,.9);border:2px solid #ff3434;color:#fff;font:14px monospace;z-index:1000003;display:none;text-align:center;pointer-events:none}
      .df-damage-flash{animation:dfFlash .2s 3}
      @keyframes dfFlash{0%,100%{filter:none}50%{filter:brightness(2) sepia(1) saturate(5)}}
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    const radar = document.createElement('div');
    radar.id = 'df-radar';
    radar.innerHTML = `
      <div id="df-radar-head">
        <b>AN/APG-77 // B-SCOPE</b>
        <span>
          <button id="df-range">RNG 80 NM</button>
          <button id="df-radar-hide">HIDE</button>
        </span>
      </div>
      <canvas id="df-radar-canvas" width="360" height="250"></canvas>
      <div id="df-radar-footer">0 CONTACT · MODE RWS</div>`;
    document.body.appendChild(radar);

    const alert = document.createElement('div');
    alert.id = 'df-alert';
    document.body.appendChild(alert);

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]));
    }

    function connect() {
      const room = $('df-room').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
      const callsign = $('df-callsign').value.trim().slice(0, 24) || 'PILOT';

      if (!room) {
        notify('Entrez un code de salon.', '#ffcc66');
        return;
      }

      session.room = room;
      session.callsign = callsign;
      saveSession();

      if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
        state.manualClose = true;
        state.ws.close();
      }

      if (!WS_URL.startsWith('wss://') && !WS_URL.startsWith('ws://')) {
        notify('Configurez WS_URL dans le script.', '#ff7777');
        return;
      }

      if (WS_URL.includes('VOTRE-PROJET')) {
        notify('Remplacez VOTRE-PROJET par le domaine Vercel.', '#ff7777');
        return;
      }

      setStatus('CONNEXION…', '#ffcf66');
      const ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.addEventListener('open', () => {
        state.reconnectDelay = 1200;
        ws.send(JSON.stringify({
          type: 'hello',
          id: session.id,
          token: session.token,
          room: session.room,
          callsign: session.callsign,
          ammo: state.ammo,
        }));
      });

      ws.addEventListener('message', event => {
        let m;
        try {
          m = JSON.parse(event.data);
        } catch {
          return;
        }
        handleServerMessage(m);
      });

      ws.addEventListener('close', () => {
        state.connected = false;
        if (state.manualClose) {
          state.manualClose = false;
          return;
        }
        setStatus('DÉCONNECTÉ — RECONNEXION…', '#ff7777');
        setTimeout(() => {
          if (session.room && panel.isConnected) connectSilently();
        }, state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.8, 20000);
      });

      ws.addEventListener('error', () => setStatus('ERREUR DE CONNEXION', '#ff7777'));
    }

    function connectSilently() {
      if (state.ws &&
          (state.ws.readyState === WebSocket.OPEN ||
           state.ws.readyState === WebSocket.CONNECTING)) return;

      if (WS_URL.includes('VOTRE-PROJET')) return;

      const ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          id: session.id,
          token: session.token,
          room: session.room,
          callsign: session.callsign,
          ammo: state.ammo,
        }));
      });

      ws.addEventListener('message', event => {
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch {}
      });

      ws.addEventListener('close', () => {
        state.connected = false;
        setStatus('RECONNEXION…', '#ff7777');
        setTimeout(connectSilently, state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.8, 20000);
      });
    }

    function handleServerMessage(m) {
      switch (m.type) {
        case 'welcome':
          state.connected = true;
          state.hp = m.hp ?? 100;
          state.flares = m.flares ?? 12;
          state.chaff = m.chaff ?? 12;
          setStatus(`CONNECTÉ · SALON ${m.room}`, '#7dff9b');
          send('loadout', { ammo: state.ammo });

          if (!state.loopsStarted) {
            state.loopsStarted = true;
            setInterval(sendState, STATE_MS);
            setInterval(() => send('poll'), PING_MS);
            setInterval(() => send('players'), PLAYER_REFRESH_MS);
          }

          sendState();
          send('players');
          renderStatus();
          break;

        case 'players':
          state.players = Array.isArray(m.players)
            ? m.players.filter(p => p.id !== session.id)
            : [];

          if (!state.players.some(p => p.id === state.targetId)) {
            state.targetId = state.players[0]?.id || null;
          }

          renderPlayers();
          renderStatus();
          break;

        case 'events':
          (m.items || []).forEach(handleServerMessage);
          break;

        case 'incoming':
          state.incoming = m;
          showAlert(`MISSILE EN APPROCHE : ${m.weapon}<br>${m.counter.toUpperCase()} REQUIS · ${m.attacker || 'INCONNU'}`);
          notify(`MENACE : ${m.weapon} — ${m.counter.toUpperCase()}`, '#ff5252');

          if (state.autoCM) {
            setTimeout(() => send('counter', { counter: m.counter }), 180);
          }
          break;

        case 'counter':
          if (m.used) {
            state.incoming = null;
            hideAlert();

            if (m.counter === 'flares') state.flares = m.remaining;
            else state.chaff = m.remaining;

            notify(`${m.counter.toUpperCase()} LARGUÉS`, '#ffe47a');
          } else if (m.message) {
            notify(m.message, '#ffcc66');
          }

          renderStatus();
          break;

        case 'fired':
          state.ammo = m.ammo || state.ammo;
          notify(`${m.weapon} TIRÉ`, '#ffb76b');
          playLaunchSound();
          drawMissileLine(m.target);
          renderStatus();
          break;

        case 'ammo':
          state.ammo = m.ammo || state.ammo;
          renderStatus();
          break;

        case 'damage':
          state.incoming = null;
          state.hp = m.hp ?? state.hp;
          flashDamage();
          notify(`${m.message || 'IMPACT'} · ${m.weapon || ''} · ${Math.round(state.hp)}%`, '#ff5555');
          hideAlert();
          renderStatus();
          break;

        case 'hit':
          notify(`IMPACT SUR ${m.callsign || 'LA CIBLE'} · ${m.weapon || ''}`, '#8dff9d');
          break;

        case 'evaded':
          notify(`LEURRE EFFICACE : ${m.weapon} ÉVITÉ`, '#8dff9d');
          hideAlert();
          state.incoming = null;
          break;

        case 'kill':
          notify(`CIBLE NEUTRALISÉE : ${m.callsign || 'ADVERSAIRE'}`, '#ff5555');
          break;

        case 'shotdown':
          state.hp = 0;
          state.armed = false;
          send('arm', { value: false });
          showAlert(`APPAREIL NEUTRALISÉ<br>TOUCHÉ PAR ${m.weapon} · ${m.by || 'ADVERSAIRE'}`);
          notify('APPAREIL NEUTRALISÉ', '#ff4444');
          renderStatus();
          break;

        case 'gunResult':
          if (m.hit) drawGunTracer();
          break;

        case 'error':
          notify(m.message || 'Erreur serveur', '#ff7676');
          break;
      }
    }

    function sendState() {
      if (!state.connected) return;

      const pos = lla();
      send('state', {
        ...pos,
        heading: heading(),
        callsign: session.callsign,
        aircraft: aircraftName(),
        armed: state.armed,
      });
    }

    function renderPlayers() {
      const select = $('df-players');
      const keep = state.targetId;
      select.innerHTML = '';

      state.players.forEach(p => {
        const option = document.createElement('option');
        const range = distanceKm(lla(), p).toFixed(1);
        option.value = p.id;
        option.textContent = `${p.callsign} · ${p.aircraft || 'avion'} · ${range} km · ${Math.round(p.hp ?? 100)}%`;
        select.appendChild(option);
      });

      if (keep && state.players.some(p => p.id === keep)) {
        select.value = keep;
      }

      $('df-players-count').textContent = `${state.players.length} PILOTE(S)`;
    }

    function distanceKm(a, b) {
      const R = 6371;
      const dLat = (b.lat - a.lat) * Math.PI / 180;
      const dLon = (b.lon - a.lon) * Math.PI / 180;
      const q = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) *
        Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
    }

    function showAlert(html) {
      alert.innerHTML = html;
      alert.style.display = 'block';
    }

    function hideAlert() {
      alert.style.display = 'none';
    }

    function flashDamage() {
      document.body.classList.add('df-damage-flash');
      setTimeout(() => document.body.classList.remove('df-damage-flash'), 650);
    }

    function playLaunchSound() {
      try {
        const audio = new Audio(LAUNCH_SOUND);
        audio.volume = 0.35;
        audio.play().catch(() => {});
      } catch {}
    }

    function toggleArm() {
      state.armed = !state.armed;

      if (!state.armed) stopGun();

      send('arm', { value: state.armed });
      notify(state.armed ? 'SYSTÈME D’ARMEMENT ACTIVÉ' : 'SYSTÈME DÉSARMÉ');
      renderStatus();
    }

    function cycleWeapon() {
      state.weaponIndex = (state.weaponIndex + 1) % WEAPONS.length;
      notify(`ARME SÉLECTIONNÉE : ${selectedWeapon().name}`);
      renderStatus();
    }

    function fireMissile() {
      if (!state.armed) {
        notify('ACTIVEZ D’ABORD L’ARMEMENT (ENTRÉE)', '#ffcc66');
        return;
      }

      if (!currentTarget()) {
        notify('SÉLECTIONNEZ UN PILOTE DANS LES CONTACTS', '#ffcc66');
        return;
      }

      if (!activeAmmo()) {
        notify('PLUS DE MUNITIONS POUR CETTE ARME', '#ff7777');
        return;
      }

      send('fire', {
        target: state.targetId,
        weapon: selectedWeapon().name,
      });
    }

    function countermeasure() {
      if (!state.armed && !state.incoming) return;

      const kind = state.incoming?.counter ||
        (state.flares > 0 ? 'flares' : 'chaff');

      send('counter', { counter: kind });
    }

    function startGun() {
      if (state.gunTimer || !state.armed || !currentTarget()) return;

      state.gunTimer = setInterval(() => {
        send('gun', { target: state.targetId });

        if (performance.now() - state.lastGunVisual > 100) {
          drawGunTracer();
          state.lastGunVisual = performance.now();
        }
      }, 110);

      notify('CANON : FEU');
    }

    function stopGun() {
      if (state.gunTimer) clearInterval(state.gunTimer);
      state.gunTimer = null;
    }

    function drawGunTracer() {
      try {
        const viewer = geofs.api.viewer;
        const start = lla();
        const h = heading() * Math.PI / 180;
        const dist = 1300;
        const lat1 = start.lat * Math.PI / 180;
        const lon1 = start.lon * Math.PI / 180;
        const brng = h;
        const ang = dist / 6371000;

        const lat2 = Math.asin(
          Math.sin(lat1) * Math.cos(ang) +
          Math.cos(lat1) * Math.sin(ang) * Math.cos(brng)
        );

        const lon2 = lon1 + Math.atan2(
          Math.sin(brng) * Math.sin(ang) * Math.cos(lat1),
          Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
        );

        const end = Cesium.Cartesian3.fromDegrees(
          lon2 * 180 / Math.PI,
          lat2 * 180 / Math.PI,
          start.alt
        );

        const from = Cesium.Cartesian3.fromDegrees(
          start.lon,
          start.lat,
          start.alt
        );

        const e = viewer.entities.add({
          polyline: {
            positions: [from, end],
            width: 2,
            material: Cesium.Color.ORANGE.withAlpha(0.9),
          },
        });

        setTimeout(() => {
          try {
            viewer.entities.remove(e);
          } catch {}
        }, 130);
      } catch {}
    }

    function drawMissileLine(targetId) {
      try {
        const target = state.players.find(p => p.id === targetId);
        if (!target) return;

        const a = lla();
        const from = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.alt);
        const to = Cesium.Cartesian3.fromDegrees(
          target.lon,
          target.lat,
          target.alt || a.alt
        );

        const ent = geofs.api.viewer.entities.add({
          polyline: {
            positions: [from, to],
            width: 3,
            material: Cesium.Color.ORANGE.withAlpha(0.95),
          },
          point: {
            position: to,
            pixelSize: 5,
            color: Cesium.Color.YELLOW,
          },
        });

        setTimeout(() => {
          try {
            geofs.api.viewer.entities.remove(ent);
          } catch {}
        }, 1600);
      } catch {}
    }

    const radarCanvas = $('df-radar-canvas');
    const ctx = radarCanvas.getContext('2d');
    const ranges = [40, 80, 160, 320];

    function drawRadar() {
      const w = radarCanvas.width;
      const h = radarCanvas.height;
      const mid = w / 2;
      const base = h - 24;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#075a25';
      ctx.lineWidth = 1;

      for (let i = 1; i <= 4; i++) {
        const y = base - (i / 4) * (h - 55);
        ctx.beginPath();
        ctx.moveTo(10, y);
        ctx.lineTo(w - 10, y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(mid, 20);
      ctx.lineTo(mid, base);
      ctx.stroke();

      ctx.fillStyle = '#008e37';
      ctx.font = '9px monospace';
      ctx.fillText(
        `RWS · ${ranges[state.radarRangeIndex]} NM · HDG ${Math.round(heading())}°`,
        8,
        12
      );

      const here = lla();
      const maxM = ranges[state.radarRangeIndex] * 1852;
      const hdg = heading();
      let count = 0;

      state.players.forEach(p => {
        const distance = distanceKm(here, p) * 1000;
        if (distance > maxM) return;

        const brg = bearingTo(here, p);
        const rel = ((brg - hdg + 540) % 360) - 180;
        if (Math.abs(rel) > 60) return;

        const x = mid + (rel / 60) * (w / 2 - 24);
        const y = base - (distance / maxM) * (h - 62);

        count++;
        ctx.fillStyle = p.id === state.targetId ? '#ff3838' : '#00ff65';
        ctx.fillRect(x - 3, y - 2, 6, 4);
        ctx.fillStyle = p.id === state.targetId ? '#ff8989' : '#62d98d';
        ctx.fillText(String(p.callsign || '').slice(0, 8), x + 5, y - 4);
      });

      ctx.fillStyle = '#008e37';
      ctx.fillText('0°', mid + 4, base - 4);
      ctx.fillText('-60°', 8, base + 13);
      ctx.fillText('+60°', w - 42, base + 13);

      $('df-radar-footer').textContent =
        `${count} CONTACT(S) · TWS · ALT ${Math.round(here.alt * 3.28084)} FT`;

      requestAnimationFrame(drawRadar);
    }

    function bearingTo(a, b) {
      const p1 = a.lat * Math.PI / 180;
      const p2 = b.lat * Math.PI / 180;
      const dl = (b.lon - a.lon) * Math.PI / 180;

      const y = Math.sin(dl) * Math.cos(p2);
      const x = Math.cos(p1) * Math.sin(p2) -
        Math.sin(p1) * Math.cos(p2) * Math.cos(dl);

      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    requestAnimationFrame(drawRadar);

    function loadPylon() {
      const index = Number($('df-pylon-select').value);
      const entry = PYLON_MODELS[index];
      if (!entry) return;

      removePylon();

      try {
        geofs.aircraft.instance.addParts([{
          name: 'df_pylon',
          model: `https://OC135.github.io/test6/${entry[1]}`,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
        }]);

        state.addedPylon = true;
        $('df-pylon-status').textContent =
          `Kit chargé : ${entry[0]} (position d'origine [0,0,0]).`;

        notify(`PYLÔNES ${entry[0]} AJOUTÉS`);
      } catch (e) {
        $('df-pylon-status').textContent = `Erreur : ${e.message}`;
      }
    }

    function removePylon() {
      try {
        const parts = geofs.aircraft.instance.parts;
        const part = parts?.df_pylon;

        if (part?.object3d?.destroy) part.object3d.destroy();
        if (parts) delete parts.df_pylon;
      } catch {}

      state.addedPylon = false;
    }

    async function loadStores() {
      try {
        const response = await fetch(STORES_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        state.stores = await response.json();
        $('df-store-status').textContent =
          `${state.stores.length} modèles disponibles.`;

        renderStores();
      } catch (e) {
        $('df-store-status').textContent =
          `Bibliothèque indisponible : ${e.message}`;
      }
    }

    function renderStores() {
      const q = $('df-store-search').value.trim().toLowerCase();
      const select = $('df-store-list');
      select.innerHTML = '';

      const matches = [];

      state.stores.forEach((item, index) => {
        if (!item || !item.name || !item.model) return;
        if (!q || item.name.toLowerCase().includes(q)) {
          matches.push({ item, index });
        }
      });

      matches.slice(0, 250).forEach(({ item, index }) => {
        const o = document.createElement('option');
        o.value = String(index);
        o.textContent = item.name;
        select.appendChild(o);
      });

      $('df-store-status').textContent =
        `${matches.length} résultat(s) · ${Math.min(matches.length, 250)} affiché(s)`;
    }

    function addSelectedStore() {
      const index = Number($('df-store-list').value);
      const item = state.stores[index];

      if (!item) {
        notify('Sélectionnez un modèle.', '#ffcc66');
        return;
      }

      const partName = `df_store_${index}`;

      if (state.addedParts.has(partName)) {
        notify('Ce modèle est déjà ajouté.');
        return;
      }

      try {
        geofs.aircraft.instance.addParts([{
          name: partName,
          model: item.model,
          position: Array.isArray(item.position) ? item.position : [0, 0, 0],
          rotation: Array.isArray(item.rotation) ? item.rotation : [0, 0, 0],
        }]);

        state.addedParts.add(partName);
        notify(`MODÈLE AJOUTÉ : ${item.name}`);
      } catch (e) {
        notify(`Impossible d'ajouter : ${e.message}`, '#ff7777');
      }
    }

    function removeStores() {
      for (const name of state.addedParts) {
        try {
          const parts = geofs.aircraft.instance.parts;
          const part = parts?.[name];

          if (part?.object3d?.destroy) part.object3d.destroy();
          if (parts) delete parts[name];
        } catch {}
      }

      state.addedParts.clear();
      notify('Emports visuels retirés.');
    }

    WEAPONS.forEach((weapon, index) => {
      const option = document.createElement('option');
      option.value = weapon.name;
      option.textContent = weapon.label;
      $('df-weapon').appendChild(option);
    });

    $('df-weapon').addEventListener('change', () => {
      const index = WEAPONS.findIndex(w => w.name === $('df-weapon').value);
      if (index >= 0) state.weaponIndex = index;
      renderStatus();
    });

    PYLON_MODELS.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = entry[0];
      $('df-pylon-select').appendChild(option);
    });

    $('df-pylon-add').addEventListener('click', loadPylon);

    $('df-pylon-remove').addEventListener('click', () => {
      removePylon();
      $('df-pylon-status').textContent = 'Kit retiré.';
    });

    $('df-connect').addEventListener('click', connect);
    $('df-min').addEventListener('click', () => {
      $('df-body').hidden = !$('df-body').hidden;
    });

    $('df-refresh').addEventListener('click', () => send('players'));

    $('df-select').addEventListener('click', () => {
      state.targetId = $('df-players').value || null;
      renderStatus();
      notify(`CIBLE SÉLECTIONNÉE : ${currentTarget()?.callsign || 'AUCUNE'}`);
    });

    $('df-auto').addEventListener('click', () => {
      state.autoCM = !state.autoCM;
      renderStatus();
    });

    $('df-range').addEventListener('click', () => {
      state.radarRangeIndex = (state.radarRangeIndex + 1) % ranges.length;
      $('df-range').textContent = `RNG ${ranges[state.radarRangeIndex]} NM`;
    });

    $('df-radar-hide').addEventListener('click', () => {
      state.radarVisible = !state.radarVisible;
      radarCanvas.style.display = state.radarVisible ? 'block' : 'none';
      $('df-radar-footer').style.display = state.radarVisible ? 'block' : 'none';
      $('df-radar-hide').textContent = state.radarVisible ? 'HIDE' : 'SHOW';
    });

    $('df-store-search').addEventListener('input', renderStores);
    $('df-store-add').addEventListener('click', addSelectedStore);
    $('df-store-remove').addEventListener('click', removeStores);

    document.addEventListener('keydown', e => {
      if (activeInput()) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        toggleArm();
      } else if (e.key.toLowerCase() === 'w') {
        e.preventDefault();
        cycleWeapon();
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) fireMissile();
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (!e.repeat) startGun();
      } else if (e.key === 'Shift') {
        e.preventDefault();
        if (!e.repeat) countermeasure();
      }
    });

    document.addEventListener('keyup', e => {
      if (e.key.toLowerCase() === 'd') stopGun();
    });

    window.addEventListener('blur', stopGun);

    loadStores();
    renderStatus();
    notify('DOGFIGHT ADDON PRÊT · CONFIGUREZ LE SALON ET CONNECTEZ-VOUS');
  }
})();
