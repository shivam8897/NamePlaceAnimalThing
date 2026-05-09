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
const DEFAULT_ROUND_TIME = 30;
const DEFAULT_ROUNDS     = 10;
const DEFAULT_MAX        = 8;
const AUTO_ADVANCE       = 30;
const TIMER_OPTIONS      = [10, 20, 30, 60];
const ROUND_OPTIONS      = [3, 5, 10];

// Speed bonus for ranked submission order (multiple players rewarded)
const SPEED_BONUS = [20, 15, 10, 7, 5]; // index 4 used for 5th and beyond

const UNIQUE_PTS   = 100;
const SHARED_PTS   = 50;
const FULL_HOUSE_BONUS = 20;
const LAST_ROUND_MULT  = 1.5;
const VOTE_DURATION    = 60; // seconds for the evaluation phase

// ─── Fuzzy matching ──────────────────────────────────────────
function normAnswer(s) {
  return s.toLowerCase().replace(/[\s\-'.]/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) =>
    Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Cluster a new normalized answer into existing cluster keys
function clusterKey(norm, keys) {
  if (!norm) return '';
  for (const k of keys) {
    if (!k) continue;
    if (norm === k) return k;
    // Fuzzy only for words 4+ chars; allow 1 edit (one-letter typo)
    if (norm.length >= 4 && k.length >= 4 && editDistance(norm, k) <= 1) return k;
  }
  return norm; // new cluster
}

const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────
function genCode() {
  let c;
  do { c = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c));
  return c;
}

function pickLetter(used) {
  const pool = LETTERS.filter(l => !used.includes(l));
  return (pool.length ? pool : LETTERS)[Math.floor(Math.random() * (pool.length || LETTERS.length))];
}

function makeRoom(hostId, hostName, hostAvatar, opts = {}) {
  const code      = genCode();
  const roundTime = TIMER_OPTIONS.includes(+opts.timer)   ? +opts.timer   : DEFAULT_ROUND_TIME;
  const maxRounds = ROUND_OPTIONS.includes(+opts.rounds)  ? +opts.rounds  : DEFAULT_ROUNDS;
  const maxPlayers= Math.min(8, Math.max(2, parseInt(opts.maxPlayers) || DEFAULT_MAX));
  const isPublic  = opts.isPublic !== false;

  const room = {
    code, host: hostId,
    players: new Map([[hostId, { name: hostName, score: 0, avatar: hostAvatar || '🦁' }]]),
    state: 'waiting',
    round: 0, maxRounds, maxPlayers, roundTime, isPublic,
    letter: null, usedLetters: [],
    timer: null, autoTimer: null,
    timeLeft: roundTime, roundStartTime: null,
    submissions: new Map(),
    submissionOrder: [],
    roundScores: null, autoCount: 0,
    answerVotes: new Map(), // key:`${pid}_${field}` → { up:Set, down:Set }
    evalData: {}, evalTimer: null, evalTimeLeft: 0,
    scoringDone: new Set(),
  };
  rooms.set(code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code, state: room.state,
    round: room.round, maxRounds: room.maxRounds,
    maxPlayers: room.maxPlayers, roundTime: room.roundTime,
    isPublic: room.isPublic,
    letter: room.letter, timeLeft: room.timeLeft, host: room.host,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id, name: p.name, score: p.score, avatar: p.avatar || '🦁',
      submitted: room.submissions.has(id),
    })),
  };
}

function roomSummary(room) {
  const host = room.players.get(room.host);
  return {
    code: room.code, isPublic: room.isPublic,
    hostName: host?.name || '?', hostAvatar: host?.avatar || '🦁',
    playerCount: room.players.size, maxPlayers: room.maxPlayers,
    maxRounds: room.maxRounds, roundTime: room.roundTime,
  };
}

// ─── Validation ──────────────────────────────────────────────
function validateAnswer(answer, letter) {
  if (!answer || !answer.trim()) return { valid: true };
  const s = answer.trim();
  if (s[0].toUpperCase() !== letter.toUpperCase())
    return { valid: false, reason: `Must start with "${letter}"` };
  if (s.replace(/[\s\-']/g, '').length < 2)
    return { valid: false, reason: 'Too short (min 2 letters)' };
  if (!/^[a-zA-Z\s\-'.]+$/.test(s))
    return { valid: false, reason: 'Letters only, no numbers' };
  const alpha = s.replace(/[^a-zA-Z]/g, '');
  if (alpha.length >= 3 && new Set(alpha.toLowerCase()).size === 1)
    return { valid: false, reason: 'Not a real word' };
  return { valid: true };
}

// ─── Scoring (runs after evaluation phase) ───────────────────
function getEffectiveValidity(room, pid, field) {
  const ea = room.evalData[pid]?.answers[field];
  if (!ea || ea.status === 'blank') return false;
  if (ea.status === 'auto_invalid') return false;
  // needs_vote: majority invalid → invalid, otherwise benefit of doubt
  const v = room.answerVotes.get(`${pid}_${field}`);
  if (v) {
    const eligible = Math.max(1, room.players.size - 1);
    if (v.down.size > eligible / 2) return false;
  }
  return true;
}

function scoreRound(room) {
  const fields    = ['name', 'place', 'animal', 'thing'];
  const isLastRnd = room.round >= room.maxRounds;

  // Build fuzzy cluster frequency maps using only effectively-valid answers
  const clusterFreq   = {};
  const answerCluster = {};
  fields.forEach(f => { clusterFreq[f] = {}; answerCluster[f] = {}; });

  room.submissions.forEach((sub, pid) => {
    fields.forEach(f => {
      if (!getEffectiveValidity(room, pid, f)) return;
      const raw = (sub[f] || '').trim();
      if (!raw) return;
      const norm = normAnswer(raw);
      const key  = clusterKey(norm, Object.keys(clusterFreq[f]));
      answerCluster[f][pid] = key;
      clusterFreq[f][key]   = (clusterFreq[f][key] || 0) + 1;
    });
  });

  const results = {};

  room.players.forEach((player, pid) => {
    const sub = room.submissions.get(pid) || {};
    let roundPts = 0;
    const breakdown = {};
    let validFilledCount = 0;

    fields.forEach(f => {
      const raw = (sub[f] || '').trim();
      const ea  = room.evalData[pid]?.answers[f];
      const effective = getEffectiveValidity(room, pid, f);

      if (!raw || ea?.status === 'blank') {
        breakdown[f] = { answer: '', points: 0, reason: 'blank' };
      } else if (ea?.status === 'auto_invalid') {
        breakdown[f] = { answer: raw, points: 0, reason: 'invalid', note: ea.note };
      } else if (!effective) {
        breakdown[f] = { answer: raw, points: 0, reason: 'voted_invalid' };
      } else {
        const ck    = answerCluster[f][pid];
        const count = ck ? (clusterFreq[f][ck] || 1) : 1;
        const pts   = count === 1 ? UNIQUE_PTS : SHARED_PTS;
        breakdown[f] = { answer: raw, points: pts, reason: count === 1 ? 'unique' : 'shared', sharedCount: count };
        roundPts += pts;
        validFilledCount++;
      }
    });

    if (validFilledCount === 4) { breakdown._fullHouse = FULL_HOUSE_BONUS; roundPts += FULL_HOUSE_BONUS; }

    if (validFilledCount >= 3) {
      const rank = room.submissionOrder.indexOf(pid);
      if (rank >= 0) {
        const spd = SPEED_BONUS[Math.min(rank, SPEED_BONUS.length - 1)];
        breakdown._speedBonus = spd; breakdown._speedRank = rank + 1; roundPts += spd;
      }
    }

    if (isLastRnd && roundPts > 0) {
      const bonus = Math.round(roundPts * (LAST_ROUND_MULT - 1));
      breakdown._lastRoundBonus = bonus; roundPts += bonus;
    }

    player.score += roundPts;
    results[pid] = { name: player.name, roundPts, totalScore: player.score, breakdown, isLastRound: isLastRnd };
  });

  return results;
}

function leaderboard(room) {
  return Array.from(room.players.entries())
    .map(([id, p]) => ({ id, name: p.name, score: p.score, avatar: p.avatar || '🦁' }))
    .sort((a, b) => b.score - a.score);
}

// ─── Round lifecycle ─────────────────────────────────────────
function startRound(room) {
  clearInterval(room.autoTimer);
  room.round++;
  room.state = 'playing';
  room.letter = pickLetter(room.usedLetters);
  room.usedLetters.push(room.letter);
  room.submissions.clear();
  room.submissionOrder = [];
  room.roundScores = null;
  room.answerVotes  = new Map();
  room.evalData     = {};
  room.scoringDone  = new Set();
  clearInterval(room.evalTimer);
  room.timeLeft = room.roundTime;
  room.roundStartTime = Date.now();

  io.to(room.code).emit('round:start', {
    round: room.round, maxRounds: room.maxRounds,
    letter: room.letter, timeLeft: room.roundTime, roundTime: room.roundTime,
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
  room.state = 'evaluating';

  const fields = ['name', 'place', 'animal', 'thing'];

  // Only auto-check: does the answer start with the correct letter?
  // Everything else goes to voters.
  room.submissions.forEach((sub, pid) => {
    const player = room.players.get(pid);
    room.evalData[pid] = { name: player?.name||'?', avatar: player?.avatar||'🦁', answers: {} };
    fields.forEach(f => {
      const raw = (sub[f]||'').trim();
      let status, note = '';
      if (!raw) {
        status = 'blank';
      } else if (raw[0].toUpperCase() !== room.letter.toUpperCase()) {
        status = 'auto_invalid';
        note   = `Must start with "${room.letter}"`;
      } else {
        status = 'needs_vote';
      }
      room.evalData[pid].answers[f] = { answer: raw, status, note };
    });
  });

  const EVAL_TIME = VOTE_DURATION;
  room.evalTimeLeft = EVAL_TIME;

  io.to(room.code).emit('evaluation:start', {
    evalData: room.evalData, letter: room.letter,
    round: room.round, maxRounds: room.maxRounds, evalTime: EVAL_TIME,
  });

  room.evalTimer = setInterval(() => {
    room.evalTimeLeft--;
    io.to(room.code).emit('evaluation:tick', { timeLeft: room.evalTimeLeft });
    if (room.evalTimeLeft <= 0) { clearInterval(room.evalTimer); finalizeEvaluation(room); }
  }, 1000);
}

function finalizeEvaluation(room) {
  if (room.state !== 'evaluating') return;
  clearInterval(room.evalTimer);
  room.state = 'scoring';

  const scores = scoreRound(room);
  room.roundScores = scores;
  const lb     = leaderboard(room);
  const isLast = room.round >= room.maxRounds;

  io.to(room.code).emit('round:end', {
    scores, leaderboard: lb, round: room.round, maxRounds: room.maxRounds, isLastRound: isLast,
  });

  if (isLast) {
    setTimeout(() => { room.state = 'gameover'; io.to(room.code).emit('game:over', { leaderboard: lb }); }, 10000);
    return;
  }

  room.autoCount = AUTO_ADVANCE;
  io.to(room.code).emit('auto:advance', { seconds: room.autoCount });
  room.autoTimer = setInterval(() => {
    room.autoCount--;
    io.to(room.code).emit('auto:tick', { seconds: room.autoCount });
    if (room.autoCount <= 0) { clearInterval(room.autoTimer); if (room.state === 'scoring') startRound(room); }
  }, 1000);
}

// ─── Smart join — fills most-populated public rooms first ────
function findBestPublicRoom(exclude) {
  return Array.from(rooms.values())
    .filter(r => r.isPublic && r.state === 'waiting' && r.players.size < r.maxPlayers)
    .filter(r => !exclude || r.host !== exclude)
    .sort((a, b) => (b.players.size / b.maxPlayers) - (a.players.size / a.maxPlayers))[0] || null;
}

// ─── Socket events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('room:create', ({ name, avatar, opts }) => {
    if (!name?.trim()) return socket.emit('err', 'Name is required');
    const room = makeRoom(socket.id, name.trim(), avatar || '🦁', opts || {});
    socket.join(room.code);
    socket.emit('room:joined', { isHost: true, ...publicRoom(room) });
    if (room.isPublic) io.emit('rooms:updated');
  });

  socket.on('room:join', ({ code, name, avatar }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();
    if (!name || !code) return socket.emit('err', 'Name and room code required');
    const room = rooms.get(code);
    if (!room)                    return socket.emit('err', 'Room not found — check the code');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already in progress');
    if (room.players.size >= room.maxPlayers) return socket.emit('err', `Room is full (max ${room.maxPlayers})`);
    if (Array.from(room.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('err', 'That name is already taken');
    room.players.set(socket.id, { name, score: 0, avatar: avatar || '🦁' });
    socket.join(code);
    socket.emit('room:joined', { isHost: false, ...publicRoom(room) });
    socket.to(code).emit('room:update', publicRoom(room));
    if (room.isPublic) io.emit('rooms:updated');
  });

  // Smart quick-join: finds the most-populated public waiting room
  socket.on('room:quick-join', ({ name, avatar }) => {
    name = (name || '').trim();
    if (!name) return socket.emit('err', 'Name is required');
    const best = findBestPublicRoom();
    if (!best) {
      // No suitable room — create a default public one
      const room = makeRoom(socket.id, name, avatar || '🦁', { isPublic: true });
      socket.join(room.code);
      socket.emit('room:joined', { isHost: true, quickJoinCreated: true, ...publicRoom(room) });
      io.emit('rooms:updated');
      return;
    }
    if (Array.from(best.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase())) {
      // Name collision — still join but note it
      return socket.emit('err', 'That name is taken in the best available room. Try another name.');
    }
    best.players.set(socket.id, { name, score: 0, avatar: avatar || '🦁' });
    socket.join(best.code);
    socket.emit('room:joined', { isHost: false, ...publicRoom(best) });
    socket.to(best.code).emit('room:update', publicRoom(best));
    io.emit('rooms:updated');
  });

  socket.on('room:set-rounds', ({ code, rounds }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'waiting') return;
    if (ROUND_OPTIONS.includes(+rounds)) { room.maxRounds = +rounds; io.to(code).emit('room:update', publicRoom(room)); }
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room)                    return socket.emit('err', 'Room not found');
    if (room.host !== socket.id)  return socket.emit('err', 'Only the host can start');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already started');
    if (room.players.size < 2)    return socket.emit('err', 'Need at least 2 players');
    room.state = 'countdown';
    if (room.isPublic) io.emit('rooms:updated');
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
    io.to(code).emit('player:submitted', { id: socket.id, submittedCount: room.submissions.size, totalPlayers: room.players.size });
    if (room.submissions.size >= room.players.size) endRound(room);
  });

  socket.on('round:next', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'scoring') return;
    clearInterval(room.autoTimer);
    if (room.round < room.maxRounds) startRound(room);
  });

  socket.on('scoring:done', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.state !== 'scoring') return;
    if (room.scoringDone.has(socket.id)) return;
    room.scoringDone.add(socket.id);
    const doneCount    = room.scoringDone.size;
    const totalPlayers = room.players.size;
    io.to(code).emit('scoring:done:update', { doneCount, totalPlayers });
    if (doneCount >= totalPlayers) {
      clearInterval(room.autoTimer);
      if (room.round < room.maxRounds) startRound(room);
    }
  });

  // Evaluation voting — records votes during the 60s evaluation phase
  socket.on('vote:answer', ({ code, targetPid, field, invalid }) => {
    const room = rooms.get(code);
    if (!room || room.state !== 'evaluating') return;
    if (targetPid === socket.id) return;
    if (!['name','place','animal','thing'].includes(field)) return;
    // Only allow voting on 'needs_vote' answers
    if (room.evalData[targetPid]?.answers[field]?.status !== 'needs_vote') return;

    const key = `${targetPid}_${field}`;
    if (!room.answerVotes.has(key)) room.answerVotes.set(key, { up:new Set(), down:new Set() });
    const v = room.answerVotes.get(key);
    if (invalid) { v.up.delete(socket.id); v.down.add(socket.id); }
    else         { v.down.delete(socket.id); v.up.add(socket.id); }
    // No live score broadcast — scores calculated at end of evaluation
  });

  socket.on('room:restart', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.players.forEach(p => { p.score = 0; });
    room.round = 0; room.state = 'waiting';
    room.usedLetters = []; room.submissions.clear(); room.submissionOrder = [];
    room.scoringDone = new Set();
    clearInterval(room.timer); clearInterval(room.autoTimer); clearInterval(room.evalTimer);
    io.to(code).emit('room:restarted', publicRoom(room));
    if (room.isPublic) io.emit('rooms:updated');
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    rooms.forEach((room, code) => {
      if (!room.players.has(socket.id)) return;
      const name = room.players.get(socket.id)?.name;
      room.players.delete(socket.id);

      if (room.players.size === 0) {
        clearInterval(room.timer); clearInterval(room.autoTimer); clearInterval(room.evalTimer);
        rooms.delete(code);
        io.emit('rooms:updated');
        return;
      }

      if (room.host === socket.id) {
        room.host = room.players.keys().next().value;
        io.to(code).emit('host:changed', { newHost: room.host, newHostName: room.players.get(room.host)?.name });
      }

      io.to(code).emit('player:left', { id: socket.id, name, ...publicRoom(room) });

      if (room.state === 'playing' && !room.submissions.has(socket.id)) {
        room.submissions.set(socket.id, { name:'', place:'', animal:'', thing:'', submittedAt: Date.now() });
        room.submissionOrder.push(socket.id);
        if (room.submissions.size >= room.players.size) endRound(room);
      }

      if (room.state === 'scoring') {
        room.scoringDone.delete(socket.id);
        const doneCount    = room.scoringDone.size;
        const totalPlayers = room.players.size;
        io.to(code).emit('scoring:done:update', { doneCount, totalPlayers });
        if (doneCount >= totalPlayers) {
          clearInterval(room.autoTimer);
          if (room.round < room.maxRounds) startRound(room);
        }
      }

      if (room.isPublic && room.state === 'waiting') io.emit('rooms:updated');
    });
  });
});

// ─── REST ─────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values())
    .filter(r => r.state === 'waiting')
    .map(roomSummary)
    .sort((a, b) => b.playerCount - a.playerCount);
  res.json(list);
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(publicRoom(room));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  Name Place Animal Thing → http://localhost:${PORT}\n`));
