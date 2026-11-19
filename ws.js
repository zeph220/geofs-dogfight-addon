import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Redis } from '@upstash/redis';

// GeoFS Dogfight backend. Redis is the shared source of truth across Vercel instances.
const server = http.createServer();
const wss = new WebSocketServer({ server });
const redis = Redis.fromEnv();

const ROOM_TTL = 3600;
const PLAYER_TTL = 25;
const EVENT_TTL = 60;
const MAX_ROOM_PLAYERS = 24;
const WEAPONS = {
  'AIM-9':   { counter: 'flares', range: 18000, speed: 900,  damage: 34, cone: 35, cooldown: 2200 },
  'AIM-9C':  { counter: 'chaff',  range: 16000, speed: 850,  damage: 30, cone: 35, cooldown: 2500 },
  'AIM-120': { counter: 'chaff',  range: 30000, speed: 1200, damage: 42, cone: 50, cooldown: 5000 },
  'AIM-54':  { counter: 'chaff',  range: 50000, speed: 1500, damage: 52, cone: 50, cooldown: 7000 },
  'R-27EA':  { counter: 'chaff',  range: 26000, speed: 1100, damage: 40, cone: 45, cooldown: 4500 },
  'R-27R':   { counter: 'chaff',  range: 22000, speed: 1000, damage: 36, cone: 40, cooldown: 4000 },
  'R-27T':   { counter: 'flares', range: 17000, speed: 900,  damage: 36, cone: 30, cooldown: 3500 },
  'R-33':    { counter: 'chaff',  range: 35000, speed: 1300, damage: 46, cone: 50, cooldown: 6000 },
  'R-73':    { counter: 'flares', range: 12000, speed: 950,  damage: 32, cone: 60, cooldown: 1800 },
  'R-77':    { counter: 'chaff',  range: 25000, speed: 1150, damage: 40, cone: 45, cooldown: 4000 },
};

const key = {
  player: id => `gf:player:${id}`,
  room: room => `gf:room:${room}`,
  events: id => `gf:events:${id}`,
  invite: id => `gf:invite:${id}`,
  duel: id => `gf:duel:${id}`,
  ammo: id => `gf:ammo:${id}`,
  incoming: id => `gf:incoming:${id}`,
  projectile: id => `gf:projectile:${id}`,
  gun: id => `gf:gun:${id}`,
  armed: id => `gf:armed:${id}`,
  cooldown: id => `gf:cooldown:${id}`,
};

function send(ws, type, data = {}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
}
async function queue(id, type, data = {}) {
  await redis.lpush(key.events(id), JSON.stringify({ type, ...data, ts: Date.now() }));
  await redis.expire(key.events(id), EVENT_TTL);
}
function parseMessage(data) {
  try { return JSON.parse(data.toString()); } catch { return null; }
}
function cleanRoom(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}
function clamp(n, min, max) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min;
}
function haversine(a, b) {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function bearing(a, b) {
  const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}
async function getPlayer(id) {
  return await redis.get(key.player(id));
}
async function getDuelMate(id) {
  return await redis.get(key.duel(id));
}
async function isDuelBetween(a, b) {
  const mate = await getDuelMate(a);
  return !!mate && mate.id === b;
}
async function getRoomPlayers(room) {
  const ids = await redis.smembers(key.room(room));
  const now = Date.now();
  const out = [];
  for (const id of ids.slice(0, MAX_ROOM_PLAYERS * 3)) {
    const p = await getPlayer(id);
    if (!p || p.room !== room || now - (p.updatedAt || 0) > PLAYER_TTL * 1000) {
      await redis.srem(key.room(room), id);
      continue;
    }
    out.push({
      id: p.id, callsign: p.callsign, aircraft: p.aircraft,
      lat: p.lat, lon: p.lon, alt: p.alt, heading: p.heading,
      hp: p.hp, online: true,
    });
  }
  return out.slice(0, MAX_ROOM_PLAYERS);
}
async function settleIncoming(targetId) {
  const ids = await redis.smembers(key.incoming(targetId));
  for (const pid of ids) {
    const shot = await redis.get(key.projectile(pid));
    if (!shot) {
      await redis.srem(key.incoming(targetId), pid);
      continue;
    }
    if (Date.now() < shot.dueAt) continue;
    if (!shot.evaded) {
      const target = await getPlayer(targetId);
      if (target) {
        target.hp = Math.max(0, Number(target.hp ?? 100) - shot.damage);
        target.updatedAt = Date.now();
        await redis.set(key.player(targetId), target, { ex: PLAYER_TTL });
        await queue(targetId, 'damage', {
          amount: shot.damage, hp: target.hp, weapon: shot.weapon,
          attacker: shot.shooterCallsign,
          message: `${shot.weapon} a touché votre appareil`,
        });
        await queue(shot.shooter, 'hit', {
          target: targetId, callsign: target.callsign,
          amount: shot.damage, hp: target.hp, weapon: shot.weapon,
        });
        if (target.hp <= 0) {
          await queue(targetId, 'shotdown', { by: shot.shooterCallsign, weapon: shot.weapon });
          await queue(shot.shooter, 'kill', { target: targetId, callsign: target.callsign, weapon: shot.weapon });
          await redis.del(key.duel(targetId), key.duel(shot.shooter));
        }
      }
    } else {
      await queue(shot.shooter, 'evaded', { target: targetId, weapon: shot.weapon });
    }
    await redis.del(key.projectile(pid));
    await redis.srem(key.incoming(targetId), pid);
  }
}
async function drainEvents(id, ws) {
  const events = [];
  for (let i = 0; i < 60; i++) {
    const raw = await redis.rpop(key.events(id));
    if (!raw) break;
    try { events.push(JSON.parse(raw)); } catch { /* ignore malformed queue item */ }
  }
  if (events.length) send(ws, 'events', { items: events });
}

wss.on('connection', ws => {
  ws.playerId = null;
  ws.token = null;
  ws.room = null;
  ws.on('message', async raw => {
    const m = parseMessage(raw);
    if (!m || typeof m.type !== 'string') return;
    try {
      if (m.type === 'hello') {
        const id = String(m.id || '').slice(0, 80);
        const token = String(m.token || '').slice(0, 100);
        const room = cleanRoom(m.room);
        if (!/^[A-Za-z0-9_-]{12,80}$/.test(id) || !/^[A-Za-z0-9_-]{16,100}$/.test(token) || !room) {
          send(ws, 'error', { message: 'Identifiant, jeton ou code de salon invalide.' }); return;
        }
        let p = await getPlayer(id);
        if (p && p.token !== token) { send(ws, 'error', { message: 'Session déjà utilisée. Rechargez le script.' }); return; }
        if (!p) p = {
          id, token, room, callsign: 'PILOT', aircraft: 'unknown',
          lat: 0, lon: 0, alt: 0, heading: 0, hp: 100,
          flares: 12, chaff: 12, updatedAt: Date.now(),
        };
        p.room = room;
        p.callsign = String(m.callsign || 'PILOT').slice(0, 24);
        p.updatedAt = Date.now();
        await redis.set(key.player(id), p, { ex: PLAYER_TTL });
        if (m.armed) await redis.set(key.armed(id), true, { ex: PLAYER_TTL });
        else await redis.set(key.armed(id), false, { ex: PLAYER_TTL });
        await redis.sadd(key.room(room), id);
        await redis.expire(key.room(room), ROOM_TTL);
        await redis.set(key.ammo(id), m.ammo && typeof m.ammo === 'object' ? sanitizeAmmo(m.ammo) : defaultAmmo(), { ex: 86400 });
        ws.playerId = id; ws.token = token; ws.room = room;
        const duel = await getDuelMate(id);
        send(ws, 'welcome', { id, room, hp: p.hp, flares: p.flares, chaff: p.chaff, opponent: duel?.id || null, opponentName: duel?.callsign || '' });
        return;
      }
      const id = ws.playerId;
      if (!id || !ws.token) { send(ws, 'error', { message: 'Connexion non initialisée.' }); return; }
      const p = await getPlayer(id);
      if (!p || p.token !== ws.token) { send(ws, 'error', { message: 'Session expirée. Reconnexion nécessaire.' }); return; }

      if (m.type === 'state') {
        p.lat = clamp(m.lat, -90, 90); p.lon = clamp(m.lon, -180, 180);
        p.alt = clamp(m.alt, -500, 60000); p.heading = clamp(m.heading, 0, 360);
        p.callsign = String(m.callsign || p.callsign).slice(0, 24);
        p.aircraft = String(m.aircraft || p.aircraft).slice(0, 80);
        p.updatedAt = Date.now();
        await redis.set(key.player(id), p, { ex: PLAYER_TTL });
        if (m.armed) await redis.set(key.armed(id), true, { ex: PLAYER_TTL });
        else await redis.set(key.armed(id), false, { ex: PLAYER_TTL });
        await redis.sadd(key.room(p.room), id);
        await redis.expire(key.room(p.room), ROOM_TTL);
        await settleIncoming(id);
        return;
      }
      if (m.type === 'poll') {
        await settleIncoming(id);
        await drainEvents(id, ws);
        return;
      }
      if (m.type === 'players') {
        send(ws, 'players', { players: await getRoomPlayers(p.room) });
        return;
      }
      if (m.type === 'arm') {
        await redis.set(key.armed(id), !!m.value, { ex: PLAYER_TTL });
        send(ws, 'armed', { value: !!m.value });
        return;
      }
      if (m.type === 'loadout') {
        const ammo = sanitizeAmmo(m.ammo || {});
        await redis.set(key.ammo(id), ammo, { ex: 86400 });
        send(ws, 'ammo', { ammo });
        return;
      }
      if (m.type === 'invite') {
        const targetId = String(m.target || '');
        const target = await getPlayer(targetId);
        if (!target || target.room !== p.room || targetId === id) { send(ws, 'error', { message: 'Pilote indisponible dans ce salon.' }); return; }
        await redis.set(key.invite(targetId), { from: id, callsign: p.callsign, room: p.room }, { ex: 35 });
        await queue(targetId, 'invite', { from: id, callsign: p.callsign });
        send(ws, 'inviteSent', { target: targetId, callsign: target.callsign });
        return;
      }
      if (m.type === 'accept') {
        const inv = await redis.get(key.invite(id));
        if (!inv || inv.from !== m.from) { send(ws, 'error', { message: 'Invitation expirée.' }); return; }
        const other = await getPlayer(inv.from);
        if (!other || other.room !== p.room) { send(ws, 'error', { message: 'Le pilote n’est plus connecté.' }); return; }
        await redis.set(key.duel(id), { id: other.id, callsign: other.callsign }, { ex: 3600 });
        await redis.set(key.duel(other.id), { id, callsign: p.callsign }, { ex: 3600 });
        p.hp = 100; other.hp = 100;
        await redis.set(key.player(id), p, { ex: PLAYER_TTL });
        await redis.set(key.player(other.id), other, { ex: PLAYER_TTL });
        await redis.del(key.invite(id));
        await queue(other.id, 'duelStart', { opponent: id, callsign: p.callsign, hp: 100 });
        send(ws, 'duelStart', { opponent: other.id, callsign: other.callsign, hp: 100 });
        return;
      }
      if (m.type === 'decline') {
        const inv = await redis.get(key.invite(id));
        await redis.del(key.invite(id));
        if (inv?.from) await queue(inv.from, 'inviteDeclined', { callsign: p.callsign });
        return;
      }
      if (m.type === 'leaveDuel') {
        const mate = await getDuelMate(id);
        await redis.del(key.duel(id));
        if (mate?.id) { await redis.del(key.duel(mate.id)); await queue(mate.id, 'duelEnded', { reason: 'L’adversaire a quitté le duel.' }); }
        send(ws, 'duelEnded', { reason: 'Vous avez quitté le duel.' });
        return;
      }
      if (m.type === 'counter') {
        const kind = m.counter === 'chaff' ? 'chaff' : 'flares';
        if (p[kind] <= 0) { send(ws, 'error', { message: `Plus de ${kind === 'chaff' ? 'paillettes' : 'leurres thermiques'}.` }); return; }
        const ids = await redis.smembers(key.incoming(id));
        let chosen = null;
        for (const pid of ids) {
          const shot = await redis.get(key.projectile(pid));
          if (shot && !shot.evaded && shot.counter === kind && Date.now() < shot.dueAt) { chosen = shot; chosen.id = pid; break; }
        }
        if (!chosen) { send(ws, 'counter', { counter: kind, used: false, message: 'Aucune menace compatible à leurrer.' }); return; }
        chosen.evaded = true;
        await redis.set(key.projectile(chosen.id), chosen, { ex: 20 });
        p[kind]--;
        await redis.set(key.player(id), p, { ex: PLAYER_TTL });
        send(ws, 'counter', { counter: kind, used: true, remaining: p[kind] });
        return;
      }
      if (m.type === 'fire') {
        if (!(await redis.get(key.armed(id)))) { send(ws, 'error', { message: 'Armement désactivé.' }); return; }
        const weapon = WEAPONS[String(m.weapon || '')];
        const targetId = String(m.target || '');
        if (!weapon || !(await isDuelBetween(id, targetId))) { send(ws, 'error', { message: 'Cible ou arme invalide : duel actif requis.' }); return; }
        const target = await getPlayer(targetId);
        if (!target) { send(ws, 'error', { message: 'Cible hors ligne.' }); return; }
        const distance = haversine(p, target);
        const aim = angleDiff(p.heading, bearing(p, target));
        if (distance > weapon.range) { send(ws, 'error', { message: `Cible hors portée (${(distance / 1000).toFixed(1)} km).` }); return; }
        if (aim > weapon.cone) { send(ws, 'error', { message: `Cible hors axe (${Math.round(aim)}°).` }); return; }
        const last = Number(await redis.get(key.cooldown(id)) || 0);
        if (Date.now() - last < weapon.cooldown) { send(ws, 'error', { message: 'Séquence de tir en refroidissement.' }); return; }
        const ammo = await redis.get(key.ammo(id)) || defaultAmmo();
        if ((ammo[weaponNameKey(weapon, m.weapon)] || 0) <= 0) { send(ws, 'error', { message: `Plus de ${m.weapon}.` }); return; }
        ammo[m.weapon]--;
        await redis.set(key.ammo(id), ammo, { ex: 86400 });
        await redis.set(key.cooldown(id), Date.now(), { ex: 15 });
        const projectileId = randomUUID();
        const eta = clamp((distance / weapon.speed) * 1000, 1000, 8000);
        const shot = {
          id: projectileId, shooter: id, shooterCallsign: p.callsign,
          target: targetId, weapon: m.weapon, counter: weapon.counter,
          damage: weapon.damage, dueAt: Date.now() + eta, evaded: false,
        };
        await redis.set(key.projectile(projectileId), shot, { ex: 20 });
        await redis.sadd(key.incoming(targetId), projectileId);
        await redis.expire(key.incoming(targetId), 25);
        await queue(targetId, 'incoming', {
          projectileId, weapon: m.weapon, counter: weapon.counter,
          attacker: p.callsign, eta: Math.round(eta),
        });
        send(ws, 'fired', { weapon: m.weapon, ammo, target: targetId, eta: Math.round(eta) });
        return;
      }
      if (m.type === 'gun') {
        if (!(await redis.get(key.armed(id)))) return;
        const targetId = String(m.target || '');
        if (!(await isDuelBetween(id, targetId))) return;
        const last = Number(await redis.get(key.gun(id)) || 0);
        if (Date.now() - last < 100) return;
        await redis.set(key.gun(id), Date.now(), { ex: 3 });
        const target = await getPlayer(targetId);
        if (!target) return;
        const distance = haversine(p, target);
        const aim = angleDiff(p.heading, bearing(p, target));
        if (distance > 1500 || aim > 5) { send(ws, 'gunResult', { hit: false }); return; }
        target.hp = Math.max(0, Number(target.hp ?? 100) - 1.8);
        target.updatedAt = Date.now();
        await redis.set(key.player(targetId), target, { ex: PLAYER_TTL });
        await queue(targetId, 'damage', { amount: 1.8, hp: target.hp, weapon: 'GUN', attacker: p.callsign, message: 'Tirs de canon reçus' });
        send(ws, 'gunResult', { hit: true, target: targetId });
        send(ws, 'hit', { target: targetId, callsign: target.callsign, amount: 1.8, hp: target.hp, weapon: 'GUN' });
        if (target.hp <= 0) {
          await queue(targetId, 'shotdown', { by: p.callsign, weapon: 'GUN' });
          await queue(id, 'kill', { target: targetId, callsign: target.callsign, weapon: 'GUN' });
          await redis.del(key.duel(id), key.duel(targetId));
        }
        return;
      }
    } catch (err) {
      console.error('[GeoFS Dogfight]', err);
      send(ws, 'error', { message: 'Erreur serveur temporaire.' });
    }
  });
  ws.on('close', () => {
    // Player presence expires automatically; keep the session for a short reconnect window.
  });
});

function weaponNameKey(_weapon, name) { return name; }
function defaultAmmo() {
  return { 'AIM-9': 2, 'AIM-9C': 1, 'AIM-120': 2, 'AIM-54': 1, 'R-27EA': 1, 'R-27R': 1, 'R-27T': 1, 'R-33': 1, 'R-73': 2, 'R-77': 2 };
}
function sanitizeAmmo(source) {
  const out = {};
  for (const name of Object.keys(WEAPONS)) out[name] = clamp(parseInt(source[name], 10) || 0, 0, 12);
  return out;
}

export default server;
