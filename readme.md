# N·P·A·T — Name Place Animal Thing

A real-time multiplayer word game where players race to fill in a **Name, Place, Animal, and Thing** for a randomly chosen letter — before anyone else does.

Built with Node.js, Express, and Socket.io. Accounts required for Competitive mode. Works in any modern browser.

---

## What is this game?

Name Place Animal Thing is a classic pen-and-paper game. A random letter is announced, and every player scrambles to write down:

- **Name** — a person's first name (e.g. Napoleon)
- **Place** — a city, country, or landmark (e.g. Nepal)
- **Animal** — any creature (e.g. Narwhal)
- **Thing** — any object or concept (e.g. Notebook)

The first player to fill all four shouts "STOP!" and everyone's answers are revealed. Unique answers score more. This version brings the whole thing online with live rooms, real-time timers, AI-validated scoring, and a global leaderboard.

---

## Features

### Core Game
- **Real-time multiplayer** — up to 8 players per room via WebSockets
- **Room system** — create a room and share a 4-letter code with friends
- **Public & private rooms** — browse open rooms or join by code
- **Quick join** — drop into the busiest public room instantly
- **Host controls** — pick rounds (3, 5, 10), timer (10s–60s), and visibility
- **Smart scoring** — unique answers score more, speed bonuses for fast submitters
- **Live leaderboard** — updated after every round
- **Confetti & celebration** — winner announcement and final standings
- **Host transfer** — if the host disconnects, next player becomes host automatically
- **Play again** — restart without leaving the room

### Competitive Mode
- **Ranked matchmaking** — up to 8 players per competitive match, run in parallel
- **Timer-based start** — lobby opens when 2+ players join, 60-second countdown begins
- **Instant start** — if 8 players fill the lobby, match starts immediately
- **Competition bonus** — flat point bonus based on lobby size (2 players = +5 pts, 8 players = +50 pts)
- **Dramatic countdown** — fullscreen animated 3-2-1 overlay before match starts
- **AI-validated scoring** — answers batched and validated by Claude Haiku every 5 minutes
- **Global leaderboard** — only AI-confirmed scores appear; auto-refreshes every 5 seconds
- **Daily limit** — 5 competitive matches per player per day
- **Funny Words of the Day** — AI picks the top 3 most creative answers daily

### Auth & Profiles
- **Supabase Auth** — email/password sign-up and login, no email confirmation required
- **Persistent sessions** — stay logged in across page refreshes
- **Profile setup** — choose a character avatar (carousel picker) and display name
- **Country flag** — optional country for competitive leaderboard

### UI / UX
- **Notebook paper aesthetic** — hand-drawn fonts, torn-page cards, margin lines
- **Custom airplane cursor** — yellow paper plane with colorful trail; trail gets thicker on press
- **Smooth hover effects** — buttons lift and brighten on hover
- **Toast notifications** — non-intrusive status messages
- **Mobile-friendly** — responsive layout down to 320px

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Server | Express + Socket.io |
| Database & Auth | Supabase (PostgreSQL + Auth) |
| AI Scoring | Anthropic Claude Haiku |
| Frontend | Vanilla HTML / CSS / JavaScript |
| Fonts | Google Fonts (Bangers, Caveat, Special Elite, Patrick Hand) |

---

## Project Structure

```
nameplaceanimalthing/
├── server.js               # Express + Socket.io server, all game logic, AI batch scoring
├── package.json
├── .env                    # Secret keys — never committed (see .env.example)
├── supabase/
│   └── schema.sql          # Run once in Supabase SQL Editor to set up tables + RLS
└── public/
    ├── index.html          # Landing page — leaderboard, funny words, how-to-play
    └── game.html           # Game UI — auth, profile, lobby, game, scoring
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A [Supabase](https://supabase.com) project (free tier is fine)
- An [Anthropic API key](https://console.anthropic.com) (optional — game works without it, AI scoring disabled)

### Environment variables

Create a `.env` file in the project root (never commit this):

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
ANTHROPIC_API_KEY=sk-ant-...      # optional
PORT=3000
```

### Database setup

1. Create a Supabase project
2. Go to **SQL Editor** and paste the contents of `supabase/schema.sql`
3. Run it — this creates the `players`, `match_results`, and `funny_words` tables plus RLS policies
4. In **Authentication → Providers → Email**, turn off **Confirm email** for instant signup

### Run locally

```bash
# 1. Clone the repo
git clone https://github.com/siddhanth-thakuri/nameplaceanimalthing.git
cd nameplaceanimalthing

# 2. Install dependencies
npm install

# 3. Add your .env file (see above)

# 4. Start the server
node server.js
```

Open **http://localhost:3000** in your browser.

To test multiplayer locally, open the same URL in two or more browser tabs.

### Development (auto-restart)

```bash
npx nodemon server.js
```

---

## How to Play

### Casual mode
1. Sign up / log in
2. Click **Create Room** or **Browse Rooms**
3. Share the 4-letter room code with friends
4. Host clicks **Start Game** when ready
5. A random letter appears — fill in Name, Place, Animal, Thing starting with that letter
6. First to submit all four stops the round
7. Scores shown after each round — most unique answers win
8. Most points after all rounds wins 🏆

### Competitive mode
1. Sign up / log in and add your country (required)
2. Click **Competitive** from the menu
3. You join the open competitive lobby — watch the player count and 60s timer
4. Match starts automatically when the timer hits 0 (or all 8 spots fill)
5. Same rules as casual, but scores are AI-validated and go on the global leaderboard
6. **5 matches per day** limit
7. Competition bonus added to your final score based on lobby size

---

## Scoring

### Base scoring (all modes)
| Situation | Points |
|---|---|
| Unique answer (no one else wrote it) | 100 pts |
| Shared answer | 50 pts |
| Blank | 0 pts |
| Speed bonuses (1st–5th to submit) | +20 / +15 / +10 / +7 / +5 |
| Full house (everyone submits all fields) | +20 pts |
| Last round | 1.5× multiplier |

### Competition bonus (Competitive mode only)
| Players in match | Bonus |
|---|---|
| 2 | +5 pts |
| 3 | +10 pts |
| 4 | +15 pts |
| 5 | +20 pts |
| 6 | +30 pts |
| 7 | +40 pts |
| 8 | +50 pts |

---

## License

MIT — free to use, modify, and distribute.
