const express = require("express");
const path = require("path");
require("dotenv").config();

const { league } = require("./data");
const {
  getTeams,
  addPlayer,
  removePlayer
} = require("./database");

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
  res.json(getTeams());
});

app.post("/api/teams/:teamId/roster", (req, res) => {
  const { teamId } = req.params;
  const { name, position, nflTeam } = req.body;

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

  const addedPlayer = addPlayer(teamId, player);

  if (!addedPlayer) {
    return res.status(404).json({
      error: "Fantasy team not found."
    });
  }

  res.status(201).json(addedPlayer);
});

app.delete("/api/teams/:teamId/roster/:playerId", (req, res) => {
  const { teamId, playerId } = req.params;

  const removedPlayer = removePlayer(teamId, playerId);

  if (!removedPlayer) {
    return res.status(404).json({
      error: "Player not found."
    });
  }

  res.json(removedPlayer);
});

app.listen(PORT, () => {
  console.log(
    `Benchwarmers Fantasy Assistant is running at http://localhost:${PORT}`
  );
});