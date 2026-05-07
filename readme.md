# Name Place Animal Thing

A real-time multiplayer word game where players race to fill in a **Name, Place, Animal, and Thing** for a randomly chosen letter — before anyone else does.

Built with Node.js, Express, and Socket.io. No account needed. Works in any browser.

---

## What is this game?

Name Place Animal Thing is a classic pen-and-paper game from childhood. A random letter is announced, and every player scrambles to write down:

- **Name** — a person's first name (e.g. Napoleon)
- **Place** — a city, country, or landmark (e.g. Nepal)
- **Animal** — any creature (e.g. Narwhal)
- **Thing** — any object or concept (e.g. Notebook)

The first player to fill all four shouts "STOP!" and everyone's answers are revealed. Unique answers score more. This version brings the whole thing online with live rooms, real-time timers, and instant scoring.

---

## Features

- **Real-time multiplayer** — up to 8 players per room via WebSockets
- **Room system** — create a room and share a 4-letter code with friends
- **Host controls** — host picks number of rounds (3, 5, 7, or 10) before starting
- **45-second timer** — server-side countdown, every player sees the same clock
- **Smart scoring**
  - Unique answer = **10 points**
  - Answer shared with another player = **5 points**
  - Blank answer = **0 points**
  - First player to submit all answers = **+5 speed bonus**
- **5 rounds by default** — different random letter each round, no repeats
- **Live leaderboard** — updated after every round on a corkboard-style display
- **Celebration screen** — confetti cannon, winner announcement, and final standings when the game ends
- **Host transfer** — if the host disconnects, the next player becomes host automatically
- **Play again** — host can restart the game from the game-over screen without anyone leaving the room

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Server | Express |
| Real-time | Socket.io |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Fonts | Google Fonts (Bangers, Permanent Marker, Special Elite, Caveat) |
| Styling | Pure CSS — notebook paper aesthetic, no frameworks |

---

## Project Structure

```
NamePlaceAnimalThing/
├── server.js           # Express + Socket.io server, all game logic
├── package.json        # Dependencies
├── package-lock.json
└── public/
    ├── index.html      # Landing page
    └── game.html       # Game UI (join, lobby, play, score, celebrate)
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- npm (comes with Node.js)

### Run locally

```bash
# 1. Clone the repo
git clone https://github.com/shivam8897/NamePlaceAnimalThing.git
cd NamePlaceAnimalThing

# 2. Install dependencies
npm install

# 3. Start the server
node server.js
```

Then open **http://localhost:3000** in your browser.

To test multiplayer locally, open the same URL in two different browser tabs or windows.

### Development (auto-restart on changes)

```bash
npx nodemon server.js
```

---

## How to Play

1. Open the app and enter your name
2. Click **Create Room** — you get a 4-letter room code
3. Share the code with friends — they enter it on the join screen
4. As the host, choose how many rounds (3, 5, 7, or 10)
5. Click **Start Game** when everyone is in
6. A random letter appears on screen — the 45-second clock starts
7. Type a Name, Place, Animal, and Thing all starting with that letter
8. Hit **Submit All** (or press Enter through the fields)
9. Once everyone submits (or time runs out), answers are revealed with scores
10. Host clicks **Next Round** — repeat until the final round
11. The player with the most points wins 🏆

---

## Scoring Rules

| Situation | Points |
|---|---|
| Answer no one else wrote | 10 pts |
| Answer shared with 1+ other player | 5 pts |
| Left blank | 0 pts |
| First player to submit all four | +5 bonus |

Scoring rewards creativity and speed. If you and another player both write "Napoleon" for N, you each get 5 — not 10. Think of the obscure ones.

---

## Socket Events Reference

| Event | Direction | Description |
|---|---|---|
| `room:create` | Client → Server | Create a new room |
| `room:join` | Client → Server | Join an existing room by code |
| `room:set-rounds` | Client → Server | Host updates round count |
| `game:start` | Client → Server | Host starts the game |
| `answer:submit` | Client → Server | Player submits their answers |
| `round:next` | Client → Server | Host advances to next round |
| `room:restart` | Client → Server | Host restarts game after it ends |
| `room:joined` | Server → Client | Confirms join, sends room state |
| `room:update` | Server → Client | Room state changed (player joined/left/rounds updated) |
| `game:countdown` | Server → Client | Countdown tick (3, 2, 1) |
| `round:start` | Server → Client | New round begins, sends letter |
| `timer:tick` | Server → Client | Every second during a round |
| `player:submitted` | Server → Client | A player submitted their answers |
| `round:end` | Server → Client | Round over, sends scores + leaderboard |
| `game:over` | Server → Client | Final game over with standings |

---

## Screenshots

| Screen | Description |
|---|---|
| Landing page | Notebook-style visual, category cards, how-to-play, leaderboard |
| Join screen | Enter name, create or join a room |
| Lobby | Live player list, rounds picker, room code to share |
| Game screen | Big letter, 4 input fields, animated timer ring |
| Scoring screen | Per-player answer table with unique/shared badges |
| Game over | Confetti explosion, winner stamp, final standings |

---

## License

MIT — free to use, modify, and distribute.

---

## Author

Built by [Shivam Dubey](https://github.com/shivam8897) with a clear soul and extremely strong visual concept.
