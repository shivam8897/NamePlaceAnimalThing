const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────
const LETTERS = 'BCDFGHJKLMNPRST'.split('');
const ROUND_TIME = 45;
const DEFAULT_ROUNDS = 5;
const SCORING_WAIT = 8000;

// ─── Room helpers ─────────────────────────────────────────────
const rooms = new Map();

function genCode() {
  let code;
  do { code = crypto.randomBytes(2).toString('hex').toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function pickLetter(usedLetters) {
  const pool = LETTERS.filter(l => !usedLetters.includes(l));
  return (pool.length ? pool : LETTERS)[Math.floor(Math.random() * (pool.length || LETTERS.length))];
}

function makeRoom(hostId, hostName) {
  const code = genCode();
  const room = {
    code,
    host: hostId,
    players: new Map([[hostId, { name: hostName, score: 0 }]]),
    state: 'waiting',
    round: 0,
    maxRounds: DEFAULT_ROUNDS,
    letter: null,
    usedLetters: [],
    timer: null,
    timeLeft: ROUND_TIME,
    submissions: new Map(),
    firstSubmitter: null,
  };
  rooms.set(code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    round: room.round,
    maxRounds: room.maxRounds,
    letter: room.letter,
    timeLeft: room.timeLeft,
    host: room.host,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      submitted: room.submissions.has(id),
    })),
  };
}

// ─── Scoring ─────────────────────────────────────────────────
function scoreRound(room) {
  const fields = ['name', 'place', 'animal', 'thing'];

  // Count how many players gave each normalised answer per field
  const freq = {};
  fields.forEach(f => { freq[f] = {}; });
  room.submissions.forEach((sub) => {
    fields.forEach(f => {
      const a = (sub[f] || '').trim().toLowerCase();
      if (a) freq[f][a] = (freq[f][a] || 0) + 1;
    });
  });

  const results = {};
  room.players.forEach((player, pid) => {
    const sub = room.submissions.get(pid) || {};
    let roundPts = 0;
    const breakdown = {};

    fields.forEach(f => {
      const raw = (sub[f] || '').trim();
      const key = raw.toLowerCase();
      if (!key) {
        breakdown[f] = { answer: '', points: 0, reason: 'blank' };
      } else if (freq[f][key] === 1) {
        breakdown[f] = { answer: raw, points: 10, reason: 'unique' };
        roundPts += 10;
      } else {
        breakdown[f] = { answer: raw, points: 5, reason: 'shared' };
        roundPts += 5;
      }
    });

    if (room.firstSubmitter === pid) {
      roundPts += 5;
      breakdown._speedBonus = 5;
    }

    player.score += roundPts;
    results[pid] = { name: player.name, roundPts, totalScore: player.score, breakdown };
  });

  return results;
}

function leaderboard(room) {
  return Array.from(room.players.entries())
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Round lifecycle ─────────────────────────────────────────
function startRound(room) {
  room.round++;
  room.state = 'playing';
  room.letter = pickLetter(room.usedLetters);
  room.usedLetters.push(room.letter);
  room.submissions.clear();
  room.firstSubmitter = null;
  room.timeLeft = ROUND_TIME;

  io.to(room.code).emit('round:start', {
    round: room.round,
    maxRounds: room.maxRounds,
    letter: room.letter,
    timeLeft: ROUND_TIME,
  });

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit('timer:tick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) endRound(room);
  }, 1000);
}

function endRound(room) {
  if (room.state !== 'playing') return;
  clearInterval(room.timer);
  room.state = 'scoring';

  const scores = scoreRound(room);
  const lb = leaderboard(room);

  io.to(room.code).emit('round:end', {
    scores,
    leaderboard: lb,
    round: room.round,
    maxRounds: room.maxRounds,
    isLastRound: room.round >= room.maxRounds,
  });

  if (room.round >= room.maxRounds) {
    setTimeout(() => {
      room.state = 'gameover';
      io.to(room.code).emit('game:over', { leaderboard: lb });
    }, SCORING_WAIT);
  }
}

// ─── Socket events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('room:create', ({ name }) => {
    if (!name?.trim()) return socket.emit('err', 'Name is required');
    const room = makeRoom(socket.id, name.trim());
    socket.join(room.code);
    socket.emit('room:joined', { isHost: true, ...publicRoom(room) });
  });

  socket.on('room:join', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();
    if (!name || !code) return socket.emit('err', 'Name and room code required');

    const room = rooms.get(code);
    if (!room) return socket.emit('err', 'Room not found — check the code');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already started');
    if (room.players.size >= 8) return socket.emit('err', 'Room is full (max 8 players)');

    // Reject duplicate names
    const taken = Array.from(room.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return socket.emit('err', 'That name is already taken in this room');

    room.players.set(socket.id, { name, score: 0 });
    socket.join(code);
    socket.emit('room:joined', { isHost: false, ...publicRoom(room) });
    socket.to(code).emit('room:update', publicRoom(room));
  });

  socket.on('room:set-rounds', ({ code, rounds }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'waiting') return;
    room.maxRounds = Math.min(10, Math.max(1, parseInt(rounds) || DEFAULT_ROUNDS));
    io.to(code).emit('room:update', publicRoom(room));
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('err', 'Room not found');
    if (room.host !== socket.id) return socket.emit('err', 'Only the host can start');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already started');
    if (room.players.size < 2) return socket.emit('err', 'Need at least 2 players to start');

    room.state = 'countdown';
    let count = 3;
    io.to(code).emit('game:countdown', { count });
    const cd = setInterval(() => {
      count--;
      if (count <= 0) { clearInterval(cd); startRound(room); }
      else io.to(code).emit('game:countdown', { count });
    }, 1000);
  });

  socket.on('answer:submit', ({ code, answers }) => {
    const room = rooms.get(code);
    if (!room || room.state !== 'playing') return;
    if (room.submissions.has(socket.id)) return;

    room.submissions.set(socket.id, {
      name:   (answers?.name   || '').trim(),
      place:  (answers?.place  || '').trim(),
      animal: (answers?.animal || '').trim(),
      thing:  (answers?.thing  || '').trim(),
    });
    if (!room.firstSubmitter) room.firstSubmitter = socket.id;

    io.to(code).emit('player:submitted', {
      id: socket.id,
      submittedCount: room.submissions.size,
      totalPlayers: room.players.size,
    });

    // Everyone submitted → end early
    if (room.submissions.size >= room.players.size) endRound(room);
  });

  socket.on('round:next', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'scoring') return;
    if (room.round < room.maxRounds) startRound(room);
  });

  socket.on('room:restart', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    // Reset scores and state
    room.players.forEach(p => { p.score = 0; });
    room.round = 0;
    room.state = 'waiting';
    room.usedLetters = [];
    room.submissions.clear();
    clearInterval(room.timer);
    io.to(code).emit('room:restarted', publicRoom(room));
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    rooms.forEach((room, code) => {
      if (!room.players.has(socket.id)) return;

      const name = room.players.get(socket.id)?.name;
      room.players.delete(socket.id);

      if (room.players.size === 0) {
        clearInterval(room.timer);
        rooms.delete(code);
        return;
      }

      // Transfer host
      if (room.host === socket.id) {
        room.host = room.players.keys().next().value;
        io.to(code).emit('host:changed', { newHost: room.host, newHostName: room.players.get(room.host)?.name });
      }

      io.to(code).emit('player:left', { id: socket.id, name, ...publicRoom(room) });

      // If playing and they hadn't submitted, fill a blank so round can still end
      if (room.state === 'playing' && !room.submissions.has(socket.id)) {
        room.submissions.set(socket.id, { name: '', place: '', animal: '', thing: '' });
        if (room.submissions.size >= room.players.size) endRound(room);
      }
    });
  });
});

// ─── REST ─────────────────────────────────────────────────────
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(publicRoom(room));
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  N·P·A·T server → http://localhost:${PORT}\n`));
