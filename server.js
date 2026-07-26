const express = require("express");
const path = require("path");
require("dotenv").config();

const { league } = require("./data");
const {
  getTeams,
  addPlayer,
  removePlayer,
  getDraftPlayers,
  createDraftPlayer,
  updateDraftPlayerStatus
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

app.get("/api/players", (req, res) => {
  res.json(getDraftPlayers());
});

app.post("/api/players", (req, res) => {
  const {
    name,
    position,
    nflTeam,
    byeWeek,
    rank,
    notes
  } = req.body;

  if (!name || !position) {
    return res.status(400).json({
      error: "Player name and position are required."
    });
  }

  const player = {
    id: Date.now().toString(),
    name: name.trim(),
    position: position.trim().toUpperCase(),
    nflTeam: nflTeam ? nflTeam.trim().toUpperCase() : "",
    byeWeek: byeWeek ? Number(byeWeek) : null,
    rank: rank ? Number(rank) : null,
    notes: notes ? notes.trim() : ""
  };

  try {
    const createdPlayer = createDraftPlayer(player);
    res.status(201).json(createdPlayer);
  } catch (error) {
    res.status(500).json({
      error: "Unable to create draft player."
    });
  }
});

app.patch("/api/players/:playerId/status", (req, res) => {
  const { playerId } = req.params;
  const { status, draftedBy } = req.body;

  const allowedStatuses = ["available", "drafted"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid player status."
    });
  }

  const updatedPlayer = updateDraftPlayerStatus(
    playerId,
    status,
    status === "drafted" ? draftedBy || "other" : null
  );

  if (!updatedPlayer) {
    return res.status(404).json({
      error: "Player not found."
    });
  }

  res.json(updatedPlayer);
});

app.listen(PORT, () => {
  console.log(
    `Benchwarmers Fantasy Assistant is running at http://localhost:${PORT}`
  );
});