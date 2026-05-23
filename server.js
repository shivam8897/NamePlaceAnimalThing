require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const compression = require('compression');
const { createClient } = require('@supabase/supabase-js');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch(e) {}
const anthropic = (Anthropic && process.env.ANTHROPIC_API_KEY)
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
if (!supabase)   console.warn('[Supabase]   Not configured — competitive scores will not be saved.');
if (!anthropic)  console.warn('[Anthropic]  Not configured — AI scoring unavailable (provisional scores only).');

app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────
const LETTERS            = 'BCDFGHJKLMNPRST'.split('');
const DEFAULT_ROUND_TIME = 30;
const DEFAULT_ROUNDS     = 10;
const DEFAULT_MAX        = 8;
const AUTO_ADVANCE       = 30;
const TIMER_OPTIONS      = [10, 20, 30, 60];
const ROUND_OPTIONS      = [3, 5, 10];

const COMP_ROUNDS      = 5;
const COMP_MIN_PLAYERS = 2;    // minimum to start the lobby timer
const COMP_PLAYERS     = 8;    // maximum / instant-start
const COMP_WAIT_TIME   = 60;   // seconds after 2+ players join before auto-start
const COMP_AUTO_ADV    = 20;
const COMP_VOTE_DURATION = 30; // eval voting time for competitive mode
const COMP_DAILY_LIMIT = 5;    // competitive matches per player per day
const COMP_BONUS       = { 2:5, 3:10, 4:15, 5:20, 6:30, 7:40, 8:50 };

const SPEED_BONUS      = [20, 15, 10, 7, 5];
const UNIQUE_PTS       = 100;
const SHARED_PTS       = 50;
const FULL_HOUSE_BONUS = 20;
const LAST_ROUND_MULT  = 1.5;
const VOTE_DURATION    = 60;

const VALID_COUNTRIES = new Set([
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda',
  'Argentina','Armenia','Australia','Austria','Azerbaijan',
  'Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize',
  'Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil',
  'Brunei','Bulgaria','Burkina Faso','Burundi',
  'Cabo Verde','Cambodia','Cameroon','Canada','Central African Republic','Chad',
  'Chile','China','Colombia','Comoros','Congo','Costa Rica','Croatia','Cuba','Cyprus',
  'Czech Republic',
  'DR Congo','Denmark','Djibouti','Dominica','Dominican Republic',
  'Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia',
  'Fiji','Finland','France',
  'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea',
  'Guinea-Bissau','Guyana',
  'Haiti','Honduras','Hungary',
  'Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy',
  'Jamaica','Japan','Jordan',
  'Kazakhstan','Kenya','Kiribati','Kuwait','Kyrgyzstan',
  'Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg',
  'Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania',
  'Mauritius','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco',
  'Mozambique','Myanmar',
  'Namibia','Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria',
  'North Korea','North Macedonia','Norway',
  'Oman',
  'Pakistan','Palau','Panama','Papua New Guinea','Paraguay','Peru','Philippines',
  'Poland','Portugal',
  'Qatar',
  'Romania','Russia','Rwanda',
  'Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa',
  'San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles',
  'Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia',
  'South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname',
  'Sweden','Switzerland','Syria',
  'Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga',
  'Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu',
  'Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan',
  'Vanuatu','Vatican City','Venezuela','Vietnam',
  'Yemen','Zambia','Zimbabwe',
  // Common short-forms
  'USA','UK','UAE',
]);

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

function clusterKey(norm, keys) {
  if (!norm) return '';
  for (const k of keys) {
    if (!k) continue;
    if (norm === k) return k;
    if (norm.length >= 4 && k.length >= 4 && editDistance(norm, k) <= 1) return k;
  }
  return norm;
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
  const code       = genCode();
  const roundTime  = TIMER_OPTIONS.includes(+opts.timer)  ? +opts.timer  : DEFAULT_ROUND_TIME;
  const maxRounds  = ROUND_OPTIONS.includes(+opts.rounds) ? +opts.rounds : DEFAULT_ROUNDS;
  const maxPlayers = Math.min(8, Math.max(2, parseInt(opts.maxPlayers) || DEFAULT_MAX));
  const isPublic      = opts.isPublic !== false;
  const isCompetitive = !!opts.isCompetitive;

  const room = {
    code, host: hostId,
    players: new Map([[hostId, {
      name: hostName, score: 0, avatar: hostAvatar || '🦁',
      country: opts.country || '', playerId: opts.playerId || null,
    }]]),
    state: 'waiting',
    round: 0, maxRounds, maxPlayers, roundTime, isPublic, isCompetitive,
    letter: null, usedLetters: [],
    timer: null, autoTimer: null,
    timeLeft: roundTime, roundStartTime: null,
    submissions: new Map(), submissionOrder: [],
    roundScores: null, autoCount: 0,
    answerVotes: new Map(),
    evalData: {}, evalTimer: null, evalTimeLeft: 0,
    evalDone: new Set(),
    compStartTimer: null, compStartCount: 0,
  };
  rooms.set(code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code, state: room.state,
    round: room.round, maxRounds: room.maxRounds,
    maxPlayers: room.maxPlayers, roundTime: room.roundTime,
    isPublic: room.isPublic, isCompetitive: room.isCompetitive || false,
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

// ─── Scoring ─────────────────────────────────────────────────
function getEffectiveValidity(room, pid, field) {
  const ea = room.evalData[pid]?.answers[field];
  if (!ea || ea.status === 'blank') return false;
  if (ea.status === 'auto_invalid' || ea.status === 'ai_invalid') return false;
  if (ea.status === 'ai_valid' || ea.status === 'pending') return true;
  // needs_vote: majority invalid → invalid
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

  const clusterFreq = {}, answerCluster = {};
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
      } else if (ea?.status === 'ai_invalid') {
        breakdown[f] = { answer: raw, points: 0, reason: 'invalid', note: ea.note || 'Rejected by AI' };
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
  room.answerVotes = new Map();
  room.evalData    = {};
  room.evalDone    = new Set();
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

  const fields = ['name', 'place', 'animal', 'thing'];

  // Build evalData (auto-check letter; rest depends on mode)
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

  const evalDuration = room.isCompetitive ? COMP_VOTE_DURATION : VOTE_DURATION;

  // Both modes: player voting / evaluation
  room.state = 'evaluating';
  room.evalTimeLeft = evalDuration;

  io.to(room.code).emit('evaluation:start', {
    evalData: room.evalData, letter: room.letter,
    round: room.round, maxRounds: room.maxRounds, evalTime: evalDuration,
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

  const compBonus = (isLast && room.isCompetitive && room.compBonus) ? room.compBonus : 0;
  if (compBonus) {
    lb.forEach(e => { e.score += compBonus; });
    room.players.forEach(p => { p.score += compBonus; });
  }

  io.to(room.code).emit('round:end', {
    scores, leaderboard: lb, round: room.round, maxRounds: room.maxRounds, isLastRound: isLast, compBonus,
  });

  if (isLast) {
    if (room.isCompetitive) saveCompetitiveScores(room, lb);
    setTimeout(() => { room.state = 'gameover'; io.to(room.code).emit('game:over', { leaderboard: lb }); }, 10000);
    return;
  }

  const autoTime = room.isCompetitive ? COMP_AUTO_ADV : AUTO_ADVANCE;
  room.autoCount = autoTime;
  io.to(room.code).emit('auto:advance', { seconds: room.autoCount });
  room.autoTimer = setInterval(() => {
    room.autoCount--;
    io.to(room.code).emit('auto:tick', { seconds: room.autoCount });
    if (room.autoCount <= 0) { clearInterval(room.autoTimer); if (room.state === 'scoring') startRound(room); }
  }, 1000);
}

// ─── Competitive lobby timer ──────────────────────────────────
function emitCompTimer(room) {
  io.to(room.code).emit('competitive:timer', {
    seconds:    room.compStartCount,
    players:    room.players.size,
    maxPlayers: COMP_PLAYERS,
    minPlayers: COMP_MIN_PLAYERS,
  });
}

function launchComp(room) {
  if (room.state !== 'waiting') return;
  if (room.players.size < COMP_MIN_PLAYERS) return;
  room.compBonus = COMP_BONUS[room.players.size] || COMP_BONUS[COMP_MIN_PLAYERS];
  room.state = 'countdown';
  let count = 3;
  io.to(room.code).emit('game:countdown', { count, dramatic: true });
  const cd = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(cd);
      io.to(room.code).emit('game:countdown', { count: 0, dramatic: true });
      setTimeout(() => startRound(room), 700);
    } else {
      io.to(room.code).emit('game:countdown', { count, dramatic: true });
    }
  }, 1000);
}

function tickCompLobby(room) {
  if (room.state !== 'waiting') return;
  const n = room.players.size;

  if (n >= COMP_PLAYERS) {
    // Full house — start immediately
    if (room.compStartTimer) { clearInterval(room.compStartTimer); room.compStartTimer = null; }
    launchComp(room);
    return;
  }

  if (n >= COMP_MIN_PLAYERS) {
    if (!room.compStartTimer) {
      room.compStartCount = COMP_WAIT_TIME;
      emitCompTimer(room);
      room.compStartTimer = setInterval(() => {
        room.compStartCount--;
        emitCompTimer(room);
        if (room.compStartCount <= 0) {
          clearInterval(room.compStartTimer);
          room.compStartTimer = null;
          launchComp(room);
        }
      }, 1000);
    } else {
      // Timer already running — just update player count
      emitCompTimer(room);
    }
  } else {
    // Dropped below minimum — pause/reset timer
    if (room.compStartTimer) {
      clearInterval(room.compStartTimer);
      room.compStartTimer = null;
      room.compStartCount = COMP_WAIT_TIME;
    }
    io.to(room.code).emit('competitive:wait', { players: n, minPlayers: COMP_MIN_PLAYERS });
  }
}

// ─── Supabase: save scores ────────────────────────────────────
async function savePlayerScore(playerId, score, username, country) {
  if (!supabase || !playerId) return;
  try {
    await supabase.from('players').upsert(
      { id: playerId, username, country: country || '' },
      { onConflict: 'id' }
    );
    await supabase.from('match_results').insert({ player_id: playerId, score, ai_scored: false });
  } catch (e) {
    console.error('[Supabase] Error saving score:', e.message);
  }
}

async function saveCompetitiveScores(room, lb) {
  if (!supabase) return;
  try {
    for (const entry of lb) {
      const player = room.players.get(entry.id);
      if (!player?.playerId) continue;

      await supabase.from('players').upsert(
        { id: player.playerId, username: player.name, country: player.country || '' },
        { onConflict: 'id' }
      );

      const { error } = await supabase
        .from('match_results')
        .insert({ player_id: player.playerId, score: entry.score, ai_scored: true });

      if (error) console.error('[Supabase] match_results insert error:', error.message);
    }
    console.log(`[Supabase] Saved ${lb.length} competitive scores for room ${room.code}`);
  } catch (e) {
    console.error('[Supabase] Error saving competitive scores:', e.message);
  }
}

// ─── Funny words update ───────────────────────────────────────
async function updateFunnyWords(newWords) {
  if (!supabase || !newWords?.length) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('funny_words').delete().eq('word_date', today);
    await supabase.from('funny_words').insert(
      newWords.slice(0, 3).map((w, i) => ({
        rank: i + 1,
        answer: w.answer,
        field: w.field,
        letter: w.letter,
        player_name: w.playerName || '',
        reason: w.reason || '',
        word_date: today,
      }))
    );
    console.log(`[FunnyWords] Saved ${Math.min(newWords.length, 3)} words for ${today}`);
  } catch (e) {
    console.error('[FunnyWords] Error:', e.message);
  }
}


// ─── Smart join ───────────────────────────────────────────────
function findBestPublicRoom() {
  return Array.from(rooms.values())
    .filter(r => r.isPublic && !r.isCompetitive && r.state === 'waiting' && r.players.size < r.maxPlayers)
    .sort((a, b) => (b.players.size / b.maxPlayers) - (a.players.size / a.maxPlayers))[0] || null;
}

// ─── Shared leave/disconnect handler ─────────────────────────
async function handlePlayerLeave(socket, room, code) {
  const player = room.players.get(socket.id);
  if (!player) return;
  const name      = player.name;
  const wasInGame = ['playing','ai_scoring','evaluating','scoring'].includes(room.state);

  if (room.isCompetitive && wasInGame && player.playerId)
    savePlayerScore(player.playerId, player.score, player.name, player.country || '');

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    clearInterval(room.timer); clearInterval(room.autoTimer); clearInterval(room.evalTimer);
    if (room.compStartTimer) { clearInterval(room.compStartTimer); room.compStartTimer = null; }
    rooms.delete(code);
    io.emit('rooms:updated');
    return;
  }

  // Re-evaluate competitive lobby timer after player leaves
  if (room.isCompetitive && room.state === 'waiting') {
    tickCompLobby(room);
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

  if (room.state === 'evaluating') {
    room.evalDone.delete(socket.id);
    if (room.evalDone.size >= room.players.size) {
      clearInterval(room.evalTimer);
      finalizeEvaluation(room);
    }
  }

  if (room.isPublic && room.state === 'waiting') io.emit('rooms:updated');
}

// ─── Socket events ────────────────────────────────────────────
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
    if (room.isCompetitive)       return socket.emit('err', 'Use Competitive mode to join this match');
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

  socket.on('room:quick-join', ({ name, avatar }) => {
    name = (name || '').trim();
    if (!name) return socket.emit('err', 'Name is required');
    const best = findBestPublicRoom();
    if (!best) {
      const room = makeRoom(socket.id, name, avatar || '🦁', { isPublic: true });
      socket.join(room.code);
      socket.emit('room:joined', { isHost: true, quickJoinCreated: true, ...publicRoom(room) });
      io.emit('rooms:updated');
      return;
    }
    if (Array.from(best.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('err', 'That name is taken in the best available room. Try another name.');
    best.players.set(socket.id, { name, score: 0, avatar: avatar || '🦁' });
    socket.join(best.code);
    socket.emit('room:joined', { isHost: false, ...publicRoom(best) });
    socket.to(best.code).emit('room:update', publicRoom(best));
    io.emit('rooms:updated');
  });

  socket.on('room:competitive-join', async ({ name, avatar, country, accessToken }) => {
    name    = (name    || '').trim();
    country = (country || '').trim();
    if (!name)    return socket.emit('err', 'Name is required');
    if (!country) return socket.emit('err', 'Country is required for Competitive mode');
    if (!VALID_COUNTRIES.has(country))
      return socket.emit('err', 'Please select a valid country from the dropdown');

    // Auth check
    let userId = null;
    if (supabase) {
      if (!accessToken)
        return socket.emit('err', 'You must be logged in to play Competitive mode');
      const { data: { user }, error } = await supabase.auth.getUser(accessToken);
      if (error || !user)
        return socket.emit('err', 'Session expired — please sign in again');
      userId = user.id;

      // Daily limit: count matches played today
      const today = new Date().toISOString().slice(0, 10);
      const { count } = await supabase
        .from('match_results')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', userId)
        .gte('played_at', `${today}T00:00:00Z`);
      if (count >= COMP_DAILY_LIMIT)
        return socket.emit('err', `Daily limit reached (${COMP_DAILY_LIMIT} competitive matches per day). Come back tomorrow!`);
    }

    const COMP_OPTS = {
      isPublic: false, maxPlayers: COMP_PLAYERS, rounds: COMP_ROUNDS,
      timer: 30, isCompetitive: true,
    };

    // Find the open waiting competitive lobby (most filled first)
    const best = Array.from(rooms.values())
      .filter(r => r.isCompetitive && r.state === 'waiting' && r.players.size < COMP_PLAYERS)
      .sort((a, b) => b.players.size - a.players.size)[0] || null;

    if (!best) {
      const room = makeRoom(socket.id, name, avatar || '🦁', { ...COMP_OPTS, country, playerId: userId });
      socket.join(room.code);
      socket.emit('room:joined', { isHost: false, isCompetitive: true, ...publicRoom(room) });
      tickCompLobby(room);
      return;
    }

    if (Array.from(best.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('err', 'That name is taken in this match. Try another name.');

    best.players.set(socket.id, { name, score: 0, avatar: avatar || '🦁', country, playerId: userId });
    socket.join(best.code);
    socket.emit('room:joined', { isHost: false, isCompetitive: true, ...publicRoom(best) });
    socket.to(best.code).emit('room:update', publicRoom(best));
    tickCompLobby(best);
  });

  socket.on('room:leave', async ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.players.has(socket.id)) return;
    socket.leave(code);
    socket.emit('room:left');
    await handlePlayerLeave(socket, room, code);
  });

  socket.on('room:set-rounds', ({ code, rounds }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.state !== 'waiting') return;
    if (ROUND_OPTIONS.includes(+rounds)) { room.maxRounds = +rounds; io.to(code).emit('room:update', publicRoom(room)); }
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room)                    return socket.emit('err', 'Room not found');
    if (room.isCompetitive)       return socket.emit('err', 'Competitive matches start automatically when full');
    if (room.host !== socket.id)  return socket.emit('err', 'Only the host can start');
    if (room.state !== 'waiting') return socket.emit('err', 'Game already started');
    if (room.players.size < 2)    return socket.emit('err', 'Need at least 2 players');
    room.state = 'countdown';
    if (room.isPublic) io.emit('rooms:updated');
    let count = 3;
    io.to(code).emit('game:countdown', { count });
    const cd = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(cd);
        io.to(code).emit('game:countdown', { count: 0 });
        setTimeout(() => startRound(room), 700);
      } else {
        io.to(code).emit('game:countdown', { count });
      }
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
    if (room.isCompetitive) return;
    clearInterval(room.autoTimer);
    if (room.round < room.maxRounds) startRound(room);
  });

  socket.on('evaluation:done', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.state !== 'evaluating') return;
    if (room.evalDone.has(socket.id)) return;
    room.evalDone.add(socket.id);
    const doneCount    = room.evalDone.size;
    const totalPlayers = room.players.size;
    io.to(code).emit('evaluation:done:update', { doneCount, totalPlayers });
    if (doneCount >= totalPlayers) {
      clearInterval(room.evalTimer);
      finalizeEvaluation(room);
    }
  });

  socket.on('vote:answer', ({ code, targetPid, field, invalid }) => {
    const room = rooms.get(code);
    if (!room || room.state !== 'evaluating') return;
    if (targetPid === socket.id) return;
    if (!['name','place','animal','thing'].includes(field)) return;
    if (room.evalData[targetPid]?.answers[field]?.status !== 'needs_vote') return;

    const key = `${targetPid}_${field}`;
    if (!room.answerVotes.has(key)) room.answerVotes.set(key, { up:new Set(), down:new Set() });
    const v = room.answerVotes.get(key);
    if (invalid) { v.up.delete(socket.id); v.down.add(socket.id); }
    else         { v.down.delete(socket.id); v.up.add(socket.id); }
  });

  socket.on('room:restart', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (room.isCompetitive) return;
    room.players.forEach(p => { p.score = 0; });
    room.round = 0; room.state = 'waiting';
    room.usedLetters = []; room.submissions.clear(); room.submissionOrder = [];
    room.evalDone = new Set();
    clearInterval(room.timer); clearInterval(room.autoTimer); clearInterval(room.evalTimer);
    io.to(code).emit('room:restarted', publicRoom(room));
    if (room.isPublic) io.emit('rooms:updated');
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    rooms.forEach((room, code) => {
      if (!room.players.has(socket.id)) return;
      handlePlayerLeave(socket, room, code);
    });
  });
});


// ─── REST ─────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL     || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values())
    .filter(r => r.state === 'waiting' && !r.isCompetitive)
    .map(roomSummary)
    .sort((a, b) => b.playerCount - a.playerCount);
  res.json(list);
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(publicRoom(room));
});

app.get('/api/leaderboard', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=5');
  if (!supabase) return res.json([]);
  try {
    const country = (req.query.country || '').trim();
    let query = supabase.from('leaderboard').select('*').order('rank').limit(50);
    if (country) query = query.ilike('country', `%${country}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error('[Supabase] leaderboard error:', e.message);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});

app.get('/api/funny-words', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  if (!supabase) return res.json([]);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('funny_words')
      .select('*')
      .eq('word_date', today)
      .order('rank');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error('[Supabase] funny-words error:', e.message);
    res.status(500).json({ error: 'Could not load funny words' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  Name Place Animal Thing → http://localhost:${PORT}\n`));
