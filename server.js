'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 6;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const DISCONNECT_GRACE_MS = 12000;
const CHAT_LIMIT = 220;
const COLORS = ['red', 'yellow', 'green', 'blue'];
const rooms = new Map();

const allowedOrigins = String(process.env.CLIENT_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.length
  ? (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
  : true;
const io = new Server(httpServer, { cors: { origin: corsOrigin, methods: ['GET', 'POST'] }, pingInterval: 25000, pingTimeout: 20000, maxHttpBufferSize: 1e6 });

app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'color-crew-realtime', rooms: rooms.size, uptime: Math.round(process.uptime()) }));
app.get('/api/status', (_req, res) => res.json({ online: true, maxPlayers: MAX_PLAYERS, ownerLabel: 'Chandan' }));

function randId(bytes = 10) { return crypto.randomBytes(bytes).toString('hex'); }
function cleanName(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 18) || 'Player'; }
function normalCode(value) { return String(value || '').trim().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12); }
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = 'CC' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function buildDeck() {
  const deck = []; let id = 1;
  for (const color of COLORS) {
    deck.push({ id: id++, color, value: '0', type: 'number' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, color, value: String(n), type: 'number' });
      deck.push({ id: id++, color, value: String(n), type: 'number' });
    }
    for (const [value, type] of [['SKIP', 'skip'], ['REV', 'reverse'], ['+2', 'draw2']]) {
      deck.push({ id: id++, color, value, type });
      deck.push({ id: id++, color, value, type });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: 'wild', value: 'WILD', type: 'wild' });
    deck.push({ id: id++, color: 'wild', value: '+4', type: 'wild4' });
  }
  return deck;
}
function getPlayer(room, id) { return room?.players.find(p => p.id === id) || null; }
function getSocketPlayer(socket) {
  const { roomCode: code, playerId } = socket.data || {};
  const room = rooms.get(code);
  return room && playerId ? { room, player: getPlayer(room, playerId) } : { room: null, player: null };
}
function makePlayer(name, socket, options = {}) {
  return {
    id: options.id || randId(8), token: options.token || randId(18), name: cleanName(name), avatar: options.avatar || ['😎','🦊','🐸','🐼','🦄','🐯'][Math.floor(Math.random()*6)],
    socketId: socket?.id || null, connected: !!socket, isBot: !!options.isBot, voiceActive: false, hand: [], saidUno: false, lastChatAt: 0, disconnectTimer: null
  };
}
function pushMessage(room, text, player = null, kind = 'system') {
  const message = { id: randId(5), kind, playerId: player?.id || null, name: player?.name || 'CREW', text: String(text).slice(0, CHAT_LIMIT), time: Date.now() };
  room.messages.push(message);
  if (room.messages.length > 80) room.messages.splice(0, room.messages.length - 80);
  return message;
}
function sendRoomMessage(room, text, player = null, kind = 'system') {
  const message = pushMessage(room, text, player, kind);
  for (const p of room.players) if (p.connected && p.socketId) io.to(p.socketId).emit('chat:new', message);
  return message;
}
function publicPlayer(player) {
  return { id: player.id, name: player.name, avatar: player.avatar, connected: !!player.connected, isBot: !!player.isBot, voiceActive: !!player.voiceActive, handCount: player.hand.length };
}
function canPlay(card, game) {
  if (!card || !game?.discard.length) return false;
  const top = game.discard[game.discard.length - 1];
  return card.color === 'wild' || card.color === game.currentColor || card.value === top.value;
}
function drawOne(room) {
  const g = room.game;
  if (!g.deck.length) {
    if (g.discard.length <= 1) return null;
    const top = g.discard.pop();
    g.deck = shuffle(g.discard);
    g.discard = [top];
  }
  return g.deck.pop() || null;
}
function drawCards(room, player, count) {
  for (let i = 0; i < count; i++) { const card = drawOne(room); if (card) player.hand.push(card); }
}
function nextPlayer(room, fromId, steps = 1) {
  const g = room.game;
  if (!g.order.length) return fromId;
  let index = g.order.indexOf(fromId);
  if (index < 0) index = 0;
  for (let i = 0; i < steps; i++) index = (index + g.direction + g.order.length) % g.order.length;
  return g.order[index];
}
function createGame(room) {
  const players = room.players.filter(p => p.connected || p.isBot);
  const usedIds = new Set(players.map(p => p.id));
  // Keep any seated AI replacement, but don't resurrect removed lobby players.
  const deck = shuffle(buildDeck());
  for (const p of players) { p.hand = []; p.saidUno = false; }
  for (let r = 0; r < 7; r++) for (const p of players) { const c = deck.pop(); if (c) p.hand.push(c); }
  let first = deck.pop();
  while (first && first.type !== 'number') { deck.unshift(first); shuffle(deck); first = deck.pop(); }
  if (!first) first = { id: 10000, color: 'blue', value: '0', type: 'number' };
  clearUnoTimer(room);
  room.roundNo = (room.roundNo || 0) + 1;
  return { deck, discard: [first], order: players.map(p => p.id), currentPlayerId: players[0]?.id || null, direction: 1, currentColor: first.color, drawnCardId: null, drawnBy: null, gameOver: false, winnerId: null, roundNo: room.roundNo, message: 'Cards dealt. Let the friendly chaos begin!', unoPendingPlayerId: null, unoDeadline: null, botTimer: null };
}
function snapshotFor(room, playerId) {
  const you = getPlayer(room, playerId);
  const g = room.game;
  const game = g ? {
    topCard: g.discard[g.discard.length - 1] || null,
    currentPlayerId: g.currentPlayerId, direction: g.direction, currentColor: g.currentColor,
    drawnCardId: g.drawnCardId, drawnBy: g.drawnBy, deckCount: g.deck.length,
    discardCount: g.discard.length, gameOver: g.gameOver, winnerId: g.winnerId,
    roundNo: g.roundNo, message: g.message, unoPendingPlayerId: g.unoPendingPlayerId, unoDeadline: g.unoDeadline
  } : null;
  return {
    code: room.code, ownerLabel: 'Chandan', ownerPlayerId: room.ownerPlayerId,
    status: room.status, players: room.players.map(publicPlayer),
    you: you ? { id: you.id, name: you.name, avatar: you.avatar, connected: !!you.connected, isBot: !!you.isBot, hand: you.hand.map(c => ({ ...c })), handCount: you.hand.length, voiceActive: !!you.voiceActive } : null,
    game, messages: room.messages.slice(-45)
  };
}
function emitRoomState(room) {
  room.lastActivity = Date.now();
  for (const player of room.players) {
    if (player.connected && player.socketId) io.to(player.socketId).emit('room:state', snapshotFor(room, player.id));
  }
}
function clearUnoTimer(room) {
  if (room.unoTimer) clearTimeout(room.unoTimer);
  room.unoTimer = null;
}
function closeUnoWindowBeforeAction(room, actor) {
  const g = room.game;
  if (!g?.unoPendingPlayerId || g.unoPendingPlayerId === actor.id) return;
  const target = getPlayer(room, g.unoPendingPlayerId);
  clearUnoTimer(room);
  g.unoPendingPlayerId = null; g.unoDeadline = null;
  if (target && target.hand.length === 1 && !target.isBot) {
    drawCards(room, target, 2);
    target.saidUno = false;
    g.message = `${target.name} forgot UNO — 2-card penalty!`;
    sendRoomMessage(room, g.message);
  }
}
function scheduleUnoPenalty(room) {
  clearUnoTimer(room);
  const g = room.game;
  if (!g?.unoPendingPlayerId || !g.unoDeadline) return;
  const pendingId = g.unoPendingPlayerId;
  room.unoTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || currentRoom !== room || !room.game) return;
    const activeGame = room.game;
    if (activeGame.unoPendingPlayerId !== pendingId || activeGame.gameOver) return;
    const p = getPlayer(room, pendingId);
    if (!p || p.isBot) { activeGame.unoPendingPlayerId = null; activeGame.unoDeadline = null; emitRoomState(room); return; }
    drawCards(room, p, 2);
    activeGame.unoPendingPlayerId = null; activeGame.unoDeadline = null; activeGame.message = `${p.name} forgot UNO — 2-card penalty!`;
    sendRoomMessage(room, activeGame.message);
    emitRoomState(room);
  }, Math.max(50, g.unoDeadline - Date.now()));
}
function createRoomObject(code, player) {
  return { code, ownerLabel: 'Chandan', ownerPlayerId: player.id, players: [player], status: 'lobby', game: null, messages: [], roundNo: 0, createdAt: Date.now(), lastActivity: Date.now(), botTimer: null, unoTimer: null };
}
function errorAck(ack, message) { if (typeof ack === 'function') ack({ ok: false, message }); }
function okAck(ack, data = {}) { if (typeof ack === 'function') ack({ ok: true, ...data }); }
function attachSocketToPlayer(socket, room, player) {
  if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
  if (player.socketId && player.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(player.socketId);
    if (oldSocket) { oldSocket.data.roomCode = null; oldSocket.data.playerId = null; oldSocket.leave(room.code); }
  }
  player.socketId = socket.id; player.connected = true; player.isBot = false; player.voiceActive = false;
  socket.data.roomCode = room.code; socket.data.playerId = player.id; socket.join(room.code); room.lastActivity = Date.now();
}
function findPlayerByToken(room, playerId, token) {
  const player = getPlayer(room, playerId);
  return player && token && player.token === token ? player : null;
}
function safeEmitError(socket, message) { socket.emit('room:error', { message }); }
function queueBotTurn(room, delay = 850) {
  if (!room?.game || room.game.gameOver || room.botTimer) return;
  const humans = room.players.filter(p => p.connected && !p.isBot).length;
  if (!humans) return; // No need to let bots play against bots when the whole crew is offline.
  const current = getPlayer(room, room.game.currentPlayerId);
  if (!current?.isBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.code) || !room.game || room.game.gameOver) return;
    const p = getPlayer(room, room.game.currentPlayerId);
    if (!p?.isBot) return;
    runBotTurn(room, p);
  }, delay + Math.floor(Math.random() * 350));
}
function runBotTurn(room, player) {
  const g = room.game;
  if (!g || g.gameOver || g.currentPlayerId !== player.id) return;
  const privateDraw = g.drawnBy === player.id ? player.hand.find(c => c.id === g.drawnCardId) : null;
  let candidate;
  if (g.drawnCardId && g.drawnBy === player.id) {
    candidate = privateDraw && canPlay(privateDraw, g) ? privateDraw : null;
    if (!candidate) { g.drawnCardId = null; g.drawnBy = null; g.message = `${player.name} drew a card and passed.`; advanceTo(room, player.id, 1); emitRoomState(room); queueBotTurn(room, 700); return; }
  } else {
    const legal = player.hand.filter(c => canPlay(c, g) && (c.type !== 'wild4' || !player.hand.some(x => x.id !== c.id && x.color === g.currentColor)));
    if (legal.length) candidate = legal.sort((a,b) => botScore(b, player) - botScore(a, player))[0];
    else {
      const card = drawOne(room); if (card) player.hand.push(card);
      if (card && canPlay(card, g) && (card.type !== 'wild4' || !player.hand.some(x => x.id !== card.id && x.color === g.currentColor))) candidate = card;
      else { g.message = `${player.name} drew a card and passed.`; advanceTo(room, player.id, 1); emitRoomState(room); queueBotTurn(room, 700); return; }
    }
  }
  const chosen = candidate.color === 'wild' ? botColor(player.hand.filter(c => c.id !== candidate.id)) : undefined;
  applyAction(room, player, { type: 'play', cardId: candidate.id, color: chosen }, true);
}
function botScore(card, player) {
  const value = { wild4: 7, wild: 6, draw2: 5, skip: 4, reverse: 3, number: 0 }[card.type] || 0;
  return value + player.hand.filter(c => c.color === card.color).length * .18 + Math.random() * .1;
}
function botColor(hand) { const count = { red: 0, yellow: 0, green: 0, blue: 0 }; hand.forEach(c => { if (count[c.color] !== undefined) count[c.color]++; }); return COLORS.slice().sort((a,b) => count[b] - count[a])[0] || 'blue'; }
function advanceTo(room, fromId, steps = 1) { room.game.currentPlayerId = nextPlayer(room, fromId, steps); }
function applyAction(room, player, action, internalBot = false) {
  const g = room.game;
  if (!g || g.gameOver || room.status !== 'game') return { ok: false, message: 'Round complete or not started.' };
  if (!player || (!internalBot && (!player.connected || player.isBot))) return { ok: false, message: 'Your seat is not active.' };
  if (g.currentPlayerId !== player.id && !['uno','catchUno'].includes(action.type)) return { ok: false, message: 'It is not your turn yet.' };
  if (action.type === 'uno') {
    if (g.unoPendingPlayerId !== player.id) return { ok: false, message: 'You do not need to call UNO right now.' };
    clearUnoTimer(room); g.unoPendingPlayerId = null; g.unoDeadline = null; player.saidUno = true; g.message = `${player.name} called UNO! ✨`; sendRoomMessage(room, g.message, player, 'system'); emitRoomState(room); return { ok: true };
  }
  if (action.type === 'catchUno') {
    const target = getPlayer(room, g.unoPendingPlayerId);
    if (!target || target.id === player.id || Date.now() > Number(g.unoDeadline || 0)) return { ok: false, message: 'UNO window has passed.' };
    clearUnoTimer(room); g.unoPendingPlayerId = null; g.unoDeadline = null; drawCards(room, target, 2); g.message = `${player.name} caught ${target.name} — 2 cards!`; sendRoomMessage(room, g.message); emitRoomState(room); return { ok: true };
  }
  if (action.type === 'draw') {
    if (g.drawnCardId !== null) return { ok: false, message: 'You already drew a card. Play it or pass.' };
    closeUnoWindowBeforeAction(room, player);
    const card = drawOne(room); if (!card) return { ok: false, message: 'The draw pile is empty.' };
    player.hand.push(card); g.drawnCardId = card.id; g.drawnBy = player.id; player.saidUno = false;
    g.message = `${player.name} drew a card.`; sendRoomMessage(room, g.message); emitRoomState(room);
    if (internalBot) queueBotTurn(room, 700);
    return { ok: true };
  }
  if (action.type === 'pass') {
    if (g.drawnCardId === null || g.drawnBy !== player.id) return { ok: false, message: 'Draw a card before passing.' };
    closeUnoWindowBeforeAction(room, player);
    g.drawnCardId = null; g.drawnBy = null; g.message = `${player.name} passed.`; advanceTo(room, player.id, 1); sendRoomMessage(room, g.message); emitRoomState(room); queueBotTurn(room); return { ok: true };
  }
  if (action.type === 'play') {
    const card = player.hand.find(c => Number(c.id) === Number(action.cardId));
    if (!card) return { ok: false, message: 'That card is not in your hand.' };
    if (g.drawnCardId !== null && (g.drawnBy !== player.id || Number(g.drawnCardId) !== Number(card.id))) return { ok: false, message: 'Play the card you just drew, or pass.' };
    if (!canPlay(card, g)) return { ok: false, message: 'That card does not match the top card.' };
    const colorBeforePlay = g.currentColor;
    if (card.type === 'wild4' && player.hand.some(c => c.id !== card.id && c.color === colorBeforePlay)) return { ok: false, message: 'Wild +4 is allowed only when you have no card matching the current colour.' };
    const chosenColor = card.color === 'wild' ? String(action.color || '') : card.color;
    if (card.color === 'wild' && !COLORS.includes(chosenColor)) return { ok: false, message: 'Choose red, yellow, green or blue for the Wild card.' };
    closeUnoWindowBeforeAction(room, player);
    player.hand = player.hand.filter(c => c.id !== card.id);
    g.discard.push(card); g.currentColor = chosenColor; g.drawnCardId = null; g.drawnBy = null; player.saidUno = false;
    g.message = `${player.name} played ${card.value === 'REV' ? 'Reverse' : card.value === 'SKIP' ? 'Skip' : card.value}${card.color === 'wild' ? ` · chose ${chosenColor}` : ''}.`;
    sendRoomMessage(room, g.message, player, 'system');
    if (player.hand.length === 0) {
      clearUnoTimer(room); g.unoPendingPlayerId = null; g.unoDeadline = null; g.gameOver = true; g.winnerId = player.id; g.message = `${player.name} won the round!`; room.status = 'game'; sendRoomMessage(room, g.message, player, 'system'); emitRoomState(room); return { ok: true };
    }
    // UNO window: human players have 3 seconds to call it; the crew can catch them.
    if (player.hand.length === 1) {
      if (internalBot) { player.saidUno = true; g.message = `${player.name} called UNO!`; }
      else { g.unoPendingPlayerId = player.id; g.unoDeadline = Date.now() + 3000; scheduleUnoPenalty(room); }
    }
    let steps = 1;
    if (card.type === 'reverse') { g.direction *= -1; if (g.order.length === 2) steps = 2; }
    else if (card.type === 'skip') steps = 2;
    else if (card.type === 'draw2' || card.type === 'wild4') {
      const targetId = nextPlayer(room, player.id, 1); const target = getPlayer(room, targetId); const count = card.type === 'draw2' ? 2 : 4;
      if (target) drawCards(room, target, count);
      g.message = `${player.name} made ${target?.name || 'the next player'} draw ${count} cards!`;
      sendRoomMessage(room, g.message); steps = 2;
    }
    advanceTo(room, player.id, steps); emitRoomState(room); queueBotTurn(room); return { ok: true };
  }
  return { ok: false, message: 'Unknown action.' };
}
function roomBySocket(socket) {
  const code = socket.data?.roomCode;
  const room = code && rooms.get(code);
  const player = room && getPlayer(room, socket.data?.playerId);
  return { room, player };
}
function leavePlayer(room, player, socket, intentional = false) {
  if (!room || !player) return;
  if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
  player.connected = false; player.voiceActive = false; player.socketId = null;
  if (socket) { socket.leave(room.code); socket.data.roomCode = null; socket.data.playerId = null; }
  io.to(room.code).emit('voice:peer-left', { id: socket?.id || null });
  if (room.status === 'lobby') {
    room.players = room.players.filter(p => p.id !== player.id);
    sendRoomMessage(room, `${player.name} left the lobby.`);
  } else {
    player.isBot = true;
    if (room.game?.unoPendingPlayerId === player.id) { clearUnoTimer(room); room.game.unoPendingPlayerId = null; room.game.unoDeadline = null; player.saidUno = true; }
    room.game.message = `${player.name} left — a Digital Friend took over their seat.`;
    sendRoomMessage(room, room.game.message);
  }
  room.lastActivity = Date.now(); emitRoomState(room); if (room.status === 'game') queueBotTurn(room, 500);
}
function onPlayerDisconnected(socket) {
  const { room, player } = roomBySocket(socket);
  if (!room || !player || player.socketId !== socket.id) return;
  player.connected = false; player.voiceActive = false; player.socketId = null;
  io.to(room.code).emit('voice:peer-left', { id: socket.id });
  room.lastActivity = Date.now(); emitRoomState(room);
  player.disconnectTimer = setTimeout(() => {
    if (!rooms.has(room.code) || player.socketId || player.connected) return;
    player.disconnectTimer = null;
    if (room.status === 'lobby') {
      room.players = room.players.filter(p => p.id !== player.id);
      sendRoomMessage(room, `${player.name} disconnected from the lobby.`);
    } else {
      player.isBot = true;
      if (room.game?.unoPendingPlayerId === player.id) { clearUnoTimer(room); room.game.unoPendingPlayerId = null; room.game.unoDeadline = null; player.saidUno = true; }
      room.game.message = `${player.name} disconnected — a Digital Friend took over.`;
      sendRoomMessage(room, room.game.message);
    }
    emitRoomState(room); if (room.status === 'game') queueBotTurn(room, 500);
  }, DISCONNECT_GRACE_MS);
}

io.on('connection', socket => {
  socket.data.roomCode = null; socket.data.playerId = null;
  socket.on('room:create', (payload = {}, ack) => {
    const name = cleanName(payload.name);
    const code = roomCode();
    const player = makePlayer(name, socket);
    const room = createRoomObject(code, player);
    rooms.set(code, room); attachSocketToPlayer(socket, room, player);
    sendRoomMessage(room, `${player.name} opened a table. Invite the crew!`);
    okAck(ack, { code, playerId: player.id, playerToken: player.token }); emitRoomState(room);
  });
  socket.on('room:join', (payload = {}, ack) => {
    const code = normalCode(payload.code); const room = rooms.get(code);
    if (!room) return errorAck(ack, 'Ye room nahi mila. Naya invite link mangwao ya code check karo.');
    const resumeId = String(payload.resumePlayerId || ''); const token = String(payload.playerToken || '');
    let player = resumeId ? findPlayerByToken(room, resumeId, token) : null;
    if (!player) {
      if (room.status === 'game' && !room.game?.gameOver) return errorAck(ack, 'Round chal raha hai. Next round se pehle naya player join nahi kar sakta.');
      if (room.players.length >= MAX_PLAYERS) return errorAck(ack, 'Room full hai — maximum 6 players.');
      player = makePlayer(payload.name, socket);
      room.players.push(player);
      if (room.status === 'game' && room.game?.gameOver) player.hand = [];
      sendRoomMessage(room, `${player.name} joined the crew.`);
    } else {
      player.name = cleanName(payload.name || player.name);
      player.disconnectTimer && clearTimeout(player.disconnectTimer); player.disconnectTimer = null;
      sendRoomMessage(room, `${player.name} rejoined the table.`);
    }
    attachSocketToPlayer(socket, room, player);
    okAck(ack, { code, playerId: player.id, playerToken: player.token }); emitRoomState(room); queueBotTurn(room);
  });
  socket.on('room:rejoin', (payload = {}, ack) => {
    const code = normalCode(payload.code); const room = rooms.get(code);
    if (!room) return errorAck(ack, 'Room expire ho gaya ya server restart hua. Naya room bana kar link share karo.');
    const player = findPlayerByToken(room, String(payload.playerId || ''), String(payload.playerToken || ''));
    if (!player) return errorAck(ack, 'Saved session match nahi hui. Room code se normal join karo.');
    attachSocketToPlayer(socket, room, player);
    okAck(ack, { code, playerId: player.id, playerToken: player.token });
    sendRoomMessage(room, `${player.name} reconnected.`); emitRoomState(room); queueBotTurn(room);
  });
  socket.on('room:start', (_payload = {}, ack) => {
    const { room, player } = roomBySocket(socket);
    if (!room || !player) return errorAck(ack, 'Pehle room mein join karo.');
    if (room.status !== 'lobby') return errorAck(ack, 'Game already started.');
    const realPlayers = room.players.filter(p => p.connected && !p.isBot);
    if (realPlayers.length < 2) return errorAck(ack, 'Game shuru karne ke liye kam se kam 2 players chahiye.');
    room.players = realPlayers; room.game = createGame(room); room.status = 'game';
    room.game.message = `${player.name} dealt the cards. Let the friendly chaos begin!`;
    sendRoomMessage(room, `Game started by ${player.name}. Chandan doesn't need to stay online for this table.`);
    okAck(ack, {}); emitRoomState(room); queueBotTurn(room);
  });
  socket.on('game:action', (action = {}, ack) => {
    const { room, player } = roomBySocket(socket);
    if (!room || !player) return errorAck(ack, 'Pehle room join karo.');
    const result = applyAction(room, player, action, false);
    if (!result.ok) return errorAck(ack, result.message);
    room.lastActivity = Date.now(); if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('game:new-round', (_payload = {}, ack) => {
    const { room, player } = roomBySocket(socket);
    if (!room || !player) return errorAck(ack, 'Room connection missing.');
    if (room.status !== 'game' || !room.game?.gameOver) return errorAck(ack, 'Current round abhi complete nahi hui.');
    if (!room.players.some(p => p.connected && !p.isBot)) return errorAck(ack, 'Koi connected player nahi hai.');
    room.game = createGame(room); room.status = 'game'; room.game.message = `${player.name} started a fresh round!`;
    sendRoomMessage(room, `New round ${room.game.roundNo} started by ${player.name}.`); okAck(ack, {}); emitRoomState(room); queueBotTurn(room);
  });
  socket.on('chat:send', (payload = {}, ack) => {
    const { room, player } = roomBySocket(socket); if (!room || !player || !player.connected) return errorAck(ack, 'Join the room first.');
    const text = String(payload.text || '').trim().slice(0, CHAT_LIMIT); if (!text) return errorAck(ack, 'Message is empty.');
    const now = Date.now(); if (now - player.lastChatAt < 650) return errorAck(ack, 'Thoda slow — ek second baad bhejo.');
    player.lastChatAt = now; sendRoomMessage(room, text, player, 'text'); room.lastActivity = now; okAck(ack, {});
  });
  socket.on('voice:ready', (payload = {}) => {
    const { room, player } = roomBySocket(socket); if (!room || !player) return;
    player.voiceActive = !!payload.active; room.lastActivity = Date.now(); emitRoomState(room);
    if (player.voiceActive) {
      const peers = room.players.filter(p => p.id !== player.id && p.connected && p.socketId && p.voiceActive).map(p => ({ id: p.socketId, name: p.name }));
      socket.emit('voice:peers', peers);
      socket.to(room.code).emit('voice:peer-ready', { id: socket.id, name: player.name });
    } else {
      socket.to(room.code).emit('voice:peer-left', { id: socket.id });
    }
  });
  socket.on('voice:signal', packet => {
    const { room, player } = roomBySocket(socket); if (!room || !player || !player.voiceActive || !packet?.to || !packet?.signal) return;
    const target = room.players.find(p => p.connected && p.socketId === packet.to && p.voiceActive);
    if (!target) return;
    io.to(target.socketId).emit('voice:signal', { from: socket.id, signal: packet.signal });
  });
  socket.on('room:leave', (_payload = {}, ack) => {
    const { room, player } = roomBySocket(socket);
    if (!room || !player) { okAck(ack, {}); return; }
    if (player.socketId === socket.id) leavePlayer(room, player, socket, true);
    okAck(ack, {});
  });
  socket.on('disconnect', () => onPlayerDisconnected(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => p.connected && !p.isBot).length;
    if (!humans && now - room.lastActivity > ROOM_IDLE_MS) {
      clearUnoTimer(room); if (room.botTimer) clearTimeout(room.botTimer);
      room.players.forEach(p => p.disconnectTimer && clearTimeout(p.disconnectTimer)); rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Color Crew Pro realtime server listening on ${PORT}`);
});
