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
  updateDraftPlayerStatus,
  importSleeperPlayers,
  getLastSleeperRefresh
} = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

const SLEEPER_PLAYERS_URL =
  "https://api.sleeper.app/v1/players/nfl?active=true";

const SLEEPER_REFRESH_INTERVAL_MS =
  24 * 60 * 60 * 1000;

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
    nflTeam: nflTeam
      ? nflTeam.trim().toUpperCase()
      : ""
  };

  try {
    const addedPlayer = addPlayer(teamId, player);

    if (!addedPlayer) {
      return res.status(404).json({
        error: "Fantasy team not found."
      });
    }

    res.status(201).json(addedPlayer);
  } catch (error) {
    console.error("Unable to add roster player:", error);

    res.status(500).json({
      error: "Unable to add roster player."
    });
  }
});

app.delete(
  "/api/teams/:teamId/roster/:playerId",
  (req, res) => {
    const { teamId, playerId } = req.params;

    try {
      const removedPlayer = removePlayer(
        teamId,
        playerId
      );

      if (!removedPlayer) {
        return res.status(404).json({
          error: "Player not found."
        });
      }

      res.json(removedPlayer);
    } catch (error) {
      console.error(
        "Unable to remove roster player:",
        error
      );

      res.status(500).json({
        error: "Unable to remove roster player."
      });
    }
  }
);

app.get("/api/players", (req, res) => {
  try {
    res.json(getDraftPlayers());
  } catch (error) {
    console.error("Unable to load players:", error);

    res.status(500).json({
      error: "Unable to load players."
    });
  }
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
    nflTeam: nflTeam
      ? nflTeam.trim().toUpperCase()
      : "",
    byeWeek: byeWeek
      ? Number(byeWeek)
      : null,
    rank: rank
      ? Number(rank)
      : null,
    notes: notes
      ? notes.trim()
      : ""
  };

  try {
    const createdPlayer = createDraftPlayer(player);

    res.status(201).json(createdPlayer);
  } catch (error) {
    console.error(
      "Unable to create draft player:",
      error
    );

    res.status(500).json({
      error: "Unable to create draft player."
    });
  }
});

app.get("/api/players/refresh-status", (req, res) => {
  const lastRefresh = getLastSleeperRefresh();

  if (!lastRefresh) {
    return res.json({
      lastRefresh: null,
      refreshAvailable: true,
      nextRefresh: null
    });
  }

  const lastRefreshTime = new Date(
    lastRefresh
  ).getTime();

  const nextRefreshTime =
    lastRefreshTime + SLEEPER_REFRESH_INTERVAL_MS;

  const refreshAvailable =
    Date.now() >= nextRefreshTime;

  res.json({
    lastRefresh,
    refreshAvailable,
    nextRefresh: new Date(
      nextRefreshTime
    ).toISOString()
  });
});

app.post("/api/players/refresh", async (req, res) => {
  const forceRefresh =
    req.query.force === "true";

  const lastRefresh = getLastSleeperRefresh();

  if (lastRefresh && !forceRefresh) {
    const lastRefreshTime = new Date(
      lastRefresh
    ).getTime();

    const nextRefreshTime =
      lastRefreshTime +
      SLEEPER_REFRESH_INTERVAL_MS;

    if (Date.now() < nextRefreshTime) {
      return res.status(429).json({
        error:
          "Sleeper players were refreshed less than 24 hours ago.",
        lastRefresh,
        nextRefresh: new Date(
          nextRefreshTime
        ).toISOString()
      });
    }
  }

  try {
    console.log(
      "Downloading active NFL players from Sleeper..."
    );

    const sleeperResponse = await fetch(
      SLEEPER_PLAYERS_URL,
      {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Benchwarmers-Fantasy-Assistant"
        },
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!sleeperResponse.ok) {
      throw new Error(
        `Sleeper returned HTTP ${sleeperResponse.status}.`
      );
    }

    const sleeperPlayers =
      await sleeperResponse.json();

    const result = importSleeperPlayers(
      sleeperPlayers
    );

    console.log(
      `Sleeper refresh complete: ${result.imported} imported, ` +
      `${result.skipped} skipped.`
    );

    res.json({
      message:
        "Sleeper player refresh completed.",
      ...result
    });
  } catch (error) {
    console.error(
      "Sleeper player refresh failed:",
      error
    );

    if (error.name === "TimeoutError") {
      return res.status(504).json({
        error:
          "The Sleeper request timed out. Please try again."
      });
    }

    res.status(502).json({
      error:
        "Unable to refresh players from Sleeper.",
      details: error.message
    });
  }
});

app.patch(
  "/api/players/:playerId/status",
  (req, res) => {
    const { playerId } = req.params;
    const { status, draftedBy } = req.body;

    const allowedStatuses = [
      "available",
      "drafted"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid player status."
      });
    }

    try {
      const updatedPlayer =
        updateDraftPlayerStatus(
          playerId,
          status,
          status === "drafted"
            ? draftedBy || "other"
            : null
        );

      if (!updatedPlayer) {
        return res.status(404).json({
          error: "Player not found."
        });
      }

      res.json(updatedPlayer);
    } catch (error) {
      console.error(
        "Unable to update player status:",
        error
      );

      res.status(500).json({
        error:
          "Unable to update player status."
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `Benchwarmers Fantasy Assistant is running at http://localhost:${PORT}`
  );
});