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
const LETTERS        = 'BCDFGHJKLMNPRST'.split('');
const ROUND_TIME     = 45;
const DEFAULT_ROUNDS = 5;
const AUTO_ADVANCE   = 30;

// Speed bonus — only awarded when player filled 3+ valid answers
const SPEED_BONUS = [8, 5, 3, 1]; // 1st, 2nd, 3rd, 4th+ (index 3 used for all beyond)

// Shared-answer tiers: score based on how many others wrote the same word
// key = number of players with that answer, value = points awarded
function sharedPoints(count) {
  if (count === 1) return 10; // unique
  if (count === 2) return 7;  // 1 other
  if (count === 3) return 5;  // 2 others
  return 3;                   // 3+ others
}

const LONG_WORD_BONUS     = 1; // answer is 8–10 chars
const VERY_LONG_WORD_BONUS = 2; // answer is 11+ chars
const FULL_HOUSE_BONUS    = 5;  // all 4 categories filled and valid
const INVALID_PENALTY     = -2; // submitting a clearly invalid answer
const LAST_ROUND_MULT     = 1.5; // final round multiplier

const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────
function genCode() {
  let c;
  do { c = crypto.randomBytes(2).toString('hex').toUpperCase(); } while (rooms.has(c));
  return c;
}

function pickLetter(used) {
  const pool = LETTERS.filter(l => !used.includes(l));
  return (pool.length ? pool : LETTERS)[Math.floor(Math.random() * (pool.length || LETTERS.length))];
}

function makeRoom(hostId, hostName) {
  const code = genCode();
  const room = {
    code, host: hostId,
    players: new Map([[hostId, { name: hostName, score: 0 }]]),
    state: 'waiting',
    round: 0, maxRounds: DEFAULT_ROUNDS,
    letter: null, usedLetters: [],
    timer: null, autoTimer: null,
    timeLeft: ROUND_TIME, roundStartTime: null,
    submissions: new Map(),   // id → { name, place, animal, thing, submittedAt }
    submissionOrder: [],      // ids in order of submission
  };
  rooms.set(code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code, state: room.state,
    round: room.round, maxRounds: room.maxRounds,
    letter: room.letter, timeLeft: room.timeLeft, host: room.host,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id, name: p.name, score: p.score,
      submitted: room.submissions.has(id),
    })),
  };
}

// ─── Validation (no external API) ────────────────────────────
function validateAnswer(answer, letter) {
  if (!answer || !answer.trim()) return { valid: true };
  const s = answer.trim();

  if (s[0].toUpperCase() !== letter.toUpperCase())
    return { valid: false, reason: `Must start with "${letter}"` };

  if (s.replace(/[\s\-']/g, '').length < 2)
    return { valid: false, reason: 'Too short (min 2 letters)' };

  if (!/^[a-zA-Z\s\-'.]+$/.test(s))
    return { valid: false, reason: 'Letters only, no numbers' };

  // Repeated single char gibberish (e.g. "NNNNN", "aaaa")
  const alpha = s.replace(/[^a-zA-Z]/g, '');
  if (alpha.length >= 3 && new Set(alpha.toLowerCase()).size === 1)
    return { valid: false, reason: 'Not a real word' };

  return { valid: true };
}

// ─── Scoring ─────────────────────────────────────────────────
function scoreRound(room) {
  const fields    = ['name', 'place', 'animal', 'thing'];
  const isLastRnd = room.round >= room.maxRounds;

  // 1. Validate every submitted answer
  const valid = {};
  room.submissions.forEach((sub, pid) => {
    valid[pid] = {};
    fields.forEach(f => { valid[pid][f] = validateAnswer(sub[f], room.letter); });
  });

  // 2. Frequency map — only valid, non-empty answers count toward shared scoring
  const freq = {};
  fields.forEach(f => { freq[f] = {}; });
  room.submissions.forEach((sub, pid) => {
    fields.forEach(f => {
      if (!valid[pid][f].valid) return;
      const a = (sub[f] || '').trim().toLowerCase();
      if (a) freq[f][a] = (freq[f][a] || 0) + 1;
    });
  });

  const results = {};

  room.players.forEach((player, pid) => {
    const sub = room.submissions.get(pid) || {};
    let roundPts = 0;
    const breakdown = {};
    let validFilledCount = 0;  // how many categories this player filled with valid answers

    // ── Per-field score ──────────────────────────────────────
    fields.forEach(f => {
      const raw = (sub[f] || '').trim();
      const key = raw.toLowerCase();
      const v   = valid[pid]?.[f] || { valid: true };

      if (!key) {
        // Blank — no points, no penalty
        breakdown[f] = { answer: '', points: 0, reason: 'blank' };

      } else if (!v.valid) {
        // Invalid — small penalty to discourage gibberish spam
        breakdown[f] = { answer: raw, points: INVALID_PENALTY, reason: 'invalid', note: v.reason };
        roundPts += INVALID_PENALTY;

      } else {
        // Valid answer — score by how many others wrote the same thing
        const count  = freq[f][key] || 1;
        const pts    = sharedPoints(count);
        const reason = count === 1 ? 'unique'
                     : count === 2 ? 'shared-1'
                     : count === 3 ? 'shared-2'
                     : 'shared-3+';

        // Long word bonus (applies on top of answer score)
        const wordLen  = raw.replace(/[\s\-']/g, '').length;
        const lenBonus = wordLen >= 11 ? VERY_LONG_WORD_BONUS
                       : wordLen >= 8  ? LONG_WORD_BONUS
                       : 0;

        breakdown[f] = { answer: raw, points: pts, reason, lenBonus };
        roundPts += pts + lenBonus;
        validFilledCount++;
      }
    });

    // ── Full house bonus: all 4 valid and filled ─────────────
    if (validFilledCount === 4) {
      breakdown._fullHouse = FULL_HOUSE_BONUS;
      roundPts += FULL_HOUSE_BONUS;
    }

    // ── Speed bonus: only if player filled 3+ valid answers ──
    if (validFilledCount >= 3) {
      const rank = room.submissionOrder.indexOf(pid);
      if (rank >= 0) {
        const spd = SPEED_BONUS[Math.min(rank, SPEED_BONUS.length - 1)];
        breakdown._speedBonus = spd;
        breakdown._speedRank  = rank + 1;
        roundPts += spd;
      }
    }

    // ── Last-round multiplier (round to nearest integer) ─────
    if (isLastRnd && roundPts > 0) {
      const bonus = Math.round(roundPts * (LAST_ROUND_MULT - 1));
      breakdown._lastRoundBonus = bonus;
      roundPts += bonus;
    }

    // Clamp to 0 minimum (can't go negative on the round)
    roundPts = Math.max(0, roundPts);

    player.score += roundPts;
    results[pid] = {
      name: player.name,
      roundPts,
      totalScore: player.score,
      breakdown,
      isLastRound: isLastRnd,
    };
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
  clearInterval(room.autoTimer);
  room.round++;
  room.state        = 'playing';
  room.letter       = pickLetter(room.usedLetters);
  room.usedLetters.push(room.letter);
  room.submissions.clear();
  room.submissionOrder = [];
  room.timeLeft     = ROUND_TIME;
  room.roundStartTime = Date.now();

  io.to(room.code).emit('round:start', {
    round: room.round, maxRounds: room.maxRounds,
    letter: room.letter, timeLeft: ROUND_TIME,
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
  const lb     = leaderboard(room);
  const isLast = room.round >= room.maxRounds;

  io.to(room.code).emit('round:end', {
    scores, leaderboard: lb,
    round: room.round, maxRounds: room.maxRounds, isLastRound: isLast,
  });

  if (isLast) {
    setTimeout(() => {
      room.state = 'gameover';
      io.to(room.code).emit('game:over', { leaderboard: lb });
    }, 10000);
    return;
  }

  // Auto-advance countdown
  let autoCount = AUTO_ADVANCE;
  io.to(room.code).emit('auto:advance', { seconds: autoCount });
  room.autoTimer = setInterval(() => {
    autoCount--;
    io.to(room.code).emit('auto:tick', { seconds: autoCount });
    if (autoCount <= 0) {
      clearInterval(room.autoTimer);
      if (room.state === 'scoring') startRound(room);
    }
  }, 1000);
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
    if (!room)                   return socket.emit('err', 'Room not found — check the code');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already in progress');
    if (room.players.size >= 8)  return socket.emit('err', 'Room is full (max 8 players)');
    if (Array.from(room.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('err', 'That name is already taken');
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
    if (!room)                         return socket.emit('err', 'Room not found');
    if (room.host !== socket.id)       return socket.emit('err', 'Only the host can start');
    if (room.state !== 'waiting')      return socket.emit('err', 'Game already started');
    if (room.players.size < 2)         return socket.emit('err', 'Need at least 2 players');
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
    if (!room || room.state !== 'playing' || room.submissions.has(socket.id)) return;
    room.submissions.set(socket.id, {
      name:   (answers?.name   || '').trim(),
      place:  (answers?.place  || '').trim(),
      animal: (answers?.animal || '').trim(),
      thing:  (answers?.thing  || '').trim(),
      submittedAt: Date.now(),
    });
    room.submissionOrder.push(socket.id);
    io.to(code).emit('player:submitted', {
      id: socket.id,
      submittedCount: room.submissions.size,
      totalPlayers: room.players.size,
    });
    if (room.submissions.size >= room.players.size) endRound(room);
  });

  socket.on('round:next', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'scoring') return;
    clearInterval(room.autoTimer);
    if (room.round < room.maxRounds) startRound(room);
  });

  socket.on('room:restart', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.players.forEach(p => { p.score = 0; });
    room.round = 0; room.state = 'waiting';
    room.usedLetters = []; room.submissions.clear(); room.submissionOrder = [];
    clearInterval(room.timer); clearInterval(room.autoTimer);
    io.to(code).emit('room:restarted', publicRoom(room));
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    rooms.forEach((room, code) => {
      if (!room.players.has(socket.id)) return;
      const name = room.players.get(socket.id)?.name;
      room.players.delete(socket.id);

      if (room.players.size === 0) {
        clearInterval(room.timer); clearInterval(room.autoTimer);
        rooms.delete(code); return;
      }

      if (room.host === socket.id) {
        room.host = room.players.keys().next().value;
        io.to(code).emit('host:changed', {
          newHost: room.host, newHostName: room.players.get(room.host)?.name,
        });
      }

      io.to(code).emit('player:left', { id: socket.id, name, ...publicRoom(room) });

      if (room.state === 'playing' && !room.submissions.has(socket.id)) {
        room.submissions.set(socket.id, { name:'', place:'', animal:'', thing:'', submittedAt: Date.now() });
        room.submissionOrder.push(socket.id);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  Name Place Animal Thing → http://localhost:${PORT}\n`));
