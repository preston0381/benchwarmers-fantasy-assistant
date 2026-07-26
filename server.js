const express = require("express");
const path = require("path");
require("dotenv").config();
const { league, teams } = require("./data");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Benchwarmers Fantasy Assistant"
  });
});
app.get("/api/league", (req, res) => {
  res.json(league);
});

app.get("/api/teams", (req, res) => {
  res.json(teams);
});

app.post("/api/teams/:teamId/roster", (req, res) => {
  const { teamId } = req.params;
  const { name, position, nflTeam } = req.body;

  const fantasyTeam = teams[teamId];

  if (!fantasyTeam) {
    return res.status(404).json({ error: "Fantasy team not found." });
  }

  if (!name || !position) {
    return res.status(400).json({
      error: "Player name and position are required."
    });
  }

  const player = {
    id: Date.now().toString(),
    name: name.trim(),
    position: position.trim().toUpperCase(),
    nflTeam: nflTeam ? nflTeam.trim().toUpperCase() : ""
  };

  fantasyTeam.roster.push(player);

  res.status(201).json(player);
});

app.delete("/api/teams/:teamId/roster/:playerId", (req, res) => {
  const { teamId, playerId } = req.params;
  const fantasyTeam = teams[teamId];

  if (!fantasyTeam) {
    return res.status(404).json({ error: "Fantasy team not found." });
  }

  const playerIndex = fantasyTeam.roster.findIndex(
    player => player.id === playerId
  );

  if (playerIndex === -1) {
    return res.status(404).json({ error: "Player not found." });
  }

  const removedPlayer = fantasyTeam.roster.splice(playerIndex, 1)[0];

  res.json(removedPlayer);
});

app.listen(PORT, () => {
  console.log(`Benchwarmers Fantasy Assistant is running at http://localhost:${PORT}`);
});