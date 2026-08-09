const express = require("express");
const path = require("path");
const multer = require("multer");
const { parse } = require("csv-parse/sync");

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
  getLastSleeperRefresh,
  importPlayerRankings,
  getRankingStatus,
  clearRankingSource
} = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

const SLEEPER_PLAYERS_URL =
  "https://api.sleeper.app/v1/players/nfl?active=true";

const SLEEPER_REFRESH_INTERVAL_MS =
  24 * 60 * 60 * 1000;

const ALLOWED_RANKING_SOURCES = new Set([
  "fantasypros",
  "pfn"
]);

/*
  Yahoo live-data layer.

  Yahoo Fantasy information will be held only in
  server memory. Nothing in this object is written
  to SQLite, files, browser storage, or app metadata.

  The session expires automatically after 6 hours.
*/
const YAHOO_SESSION_TTL_MS =
  6 * 60 * 60 * 1000;

let yahooSession = {
  data: null,
  loadedAt: null,
  expiresAt: null
};

function clearYahooSession() {
  yahooSession = {
    data: null,
    loadedAt: null,
    expiresAt: null
  };
}

function expireYahooSessionIfNeeded() {
  if (
    yahooSession.expiresAt &&
    Date.now() >= yahooSession.expiresAt
  ) {
    clearYahooSession();
  }
}

function getYahooSessionStatus() {
  expireYahooSessionIfNeeded();

  return {
    connected:
      Boolean(yahooSession.data),
    loadedAt:
      yahooSession.loadedAt,
    expiresAt:
      yahooSession.expiresAt
  };
}

const rankingUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    const filename =
      file.originalname.toLowerCase();

    const acceptedMimeTypes = new Set([
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "text/plain"
    ]);

    const isCsvFilename =
      filename.endsWith(".csv");

    const isAcceptedMimeType =
      acceptedMimeTypes.has(file.mimetype);

    if (
      !isCsvFilename &&
      !isAcceptedMimeType
    ) {
      return callback(
        new Error(
          "The uploaded rankings file must be a CSV."
        )
      );
    }

    callback(null, true);
  }
});

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

function normalizeRankingSource(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getRankingSourceLabel(source) {
  if (source === "fantasypros") {
    return "FantasyPros";
  }

  if (source === "pfn") {
    return "PFN";
  }

  return source;
}

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
  try {
    res.json(getTeams());
  } catch (error) {
    console.error(
      "Unable to load fantasy teams:",
      error
    );

    res.status(500).json({
      error: "Unable to load fantasy teams."
    });
  }
});

app.post(
  "/api/teams/:teamId/roster",
  (req, res) => {
    const { teamId } = req.params;

    const {
      name,
      position,
      nflTeam
    } = req.body;

    if (!name || !position) {
      return res.status(400).json({
        error:
          "Player name and position are required."
      });
    }

    const player = {
      id: Date.now().toString(),
      name: name.trim(),
      position:
        position.trim().toUpperCase(),
      nflTeam: nflTeam
        ? nflTeam.trim().toUpperCase()
        : ""
    };

    try {
      const addedPlayer = addPlayer(
        teamId,
        player
      );

      if (!addedPlayer) {
        return res.status(404).json({
          error: "Fantasy team not found."
        });
      }

      res.status(201).json(addedPlayer);
    } catch (error) {
      console.error(
        "Unable to add roster player:",
        error
      );

      res.status(500).json({
        error:
          "Unable to add roster player."
      });
    }
  }
);

app.delete(
  "/api/teams/:teamId/roster/:playerId",
  (req, res) => {
    const {
      teamId,
      playerId
    } = req.params;

    try {
      const removedPlayer =
        removePlayer(
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
        error:
          "Unable to remove roster player."
      });
    }
  }
);

app.get("/api/players", (req, res) => {
  try {
    res.json(getDraftPlayers());
  } catch (error) {
    console.error(
      "Unable to load players:",
      error
    );

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
      error:
        "Player name and position are required."
    });
  }

  const player = {
    id: Date.now().toString(),
    name: name.trim(),
    position:
      position.trim().toUpperCase(),
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
    const createdPlayer =
      createDraftPlayer(player);

    res.status(201).json(createdPlayer);
  } catch (error) {
    console.error(
      "Unable to create draft player:",
      error
    );

    res.status(500).json({
      error:
        "Unable to create draft player."
    });
  }
});

app.get(
  "/api/players/refresh-status",
  (req, res) => {
    try {
      const lastRefresh =
        getLastSleeperRefresh();

      if (!lastRefresh) {
        return res.json({
          lastRefresh: null,
          refreshAvailable: true,
          nextRefresh: null
        });
      }

      const lastRefreshTime =
        new Date(lastRefresh).getTime();

      const nextRefreshTime =
        lastRefreshTime +
        SLEEPER_REFRESH_INTERVAL_MS;

      const refreshAvailable =
        Date.now() >= nextRefreshTime;

      res.json({
        lastRefresh,
        refreshAvailable,
        nextRefresh: new Date(
          nextRefreshTime
        ).toISOString()
      });
    } catch (error) {
      console.error(
        "Unable to load refresh status:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load refresh status."
      });
    }
  }
);

app.post(
  "/api/players/refresh",
  async (req, res) => {
    const forceRefresh =
      req.query.force === "true";

    const lastRefresh =
      getLastSleeperRefresh();

    if (lastRefresh && !forceRefresh) {
      const lastRefreshTime =
        new Date(lastRefresh).getTime();

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

      const sleeperResponse =
        await fetch(
          SLEEPER_PLAYERS_URL,
          {
            headers: {
              Accept: "application/json",
              "User-Agent":
                "Benchwarmers-Fantasy-Assistant"
            },
            signal:
              AbortSignal.timeout(30000)
          }
        );

      if (!sleeperResponse.ok) {
        throw new Error(
          `Sleeper returned HTTP ` +
          `${sleeperResponse.status}.`
        );
      }

      const sleeperPlayers =
        await sleeperResponse.json();

      const result =
        importSleeperPlayers(
          sleeperPlayers
        );

      console.log(
        `Sleeper refresh complete: ` +
        `${result.imported} imported, ` +
        `${result.removed} removed, ` +
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

      if (
        error.name === "TimeoutError" ||
        error.name === "AbortError"
      ) {
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
  }
);

app.get(
  "/api/players/rankings/status",
  (req, res) => {
    try {
      res.json(getRankingStatus());
    } catch (error) {
      console.error(
        "Unable to load ranking status:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load ranking status."
      });
    }
  }
);

app.post(
  "/api/players/rankings/import",
  (req, res) => {
    rankingUpload.single("file")(
      req,
      res,
      error => {
        if (
          error instanceof
          multer.MulterError
        ) {
          if (
            error.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res.status(413).json({
              error:
                "The rankings CSV must be smaller than 5 MB."
            });
          }

          return res.status(400).json({
            error:
              "Unable to upload the rankings CSV.",
            details: error.message
          });
        }

        if (error) {
          return res.status(400).json({
            error: error.message
          });
        }

        if (!req.file) {
          return res.status(400).json({
            error:
              "Choose a rankings CSV file to upload."
          });
        }

        const rankingSource =
          normalizeRankingSource(
            req.body.source
          );

        if (
          !ALLOWED_RANKING_SOURCES.has(
            rankingSource
          )
        ) {
          return res.status(400).json({
            error:
              "Choose FantasyPros or PFN as the ranking source."
          });
        }

        try {
          const csvText =
            req.file.buffer.toString(
              "utf8"
            );

          const rows = parse(csvText, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            bom: true,
            relax_column_count: true
          });

          if (rows.length === 0) {
            return res.status(400).json({
              error:
                "The rankings CSV does not contain any player rows."
            });
          }

          const result =
            importPlayerRankings(
              rows,
              rankingSource
            );

          const sourceLabel =
            getRankingSourceLabel(
              rankingSource
            );

          console.log(
            `${sourceLabel} ranking import complete: ` +
            `${result.matched} matched, ` +
            `${result.unmatched} unmatched, ` +
            `${result.ambiguous} ambiguous, ` +
            `${result.invalid} invalid.`
          );

          res.json({
            message:
              `${sourceLabel} rankings were imported.`,
            filename:
              req.file.originalname,
            sourceLabel,
            ...result
          });
        } catch (parseError) {
          console.error(
            "Ranking import failed:",
            parseError
          );

          res.status(400).json({
            error:
              "Unable to read the rankings CSV.",
            details:
              parseError.message
          });
        }
      }
    );
  }
);

app.delete(
  "/api/players/rankings/:source",
  (req, res) => {
    const rankingSource =
      normalizeRankingSource(
        req.params.source
      );

    if (
      !ALLOWED_RANKING_SOURCES.has(
        rankingSource
      )
    ) {
      return res.status(400).json({
        error:
          "Ranking source must be fantasypros or pfn."
      });
    }

    try {
      const result =
        clearRankingSource(
          rankingSource
        );

      res.json({
        message:
          `${getRankingSourceLabel(
            rankingSource
          )} rankings were cleared.`,
        ...result
      });
    } catch (error) {
      console.error(
        "Unable to clear rankings:",
        error
      );

      res.status(500).json({
        error:
          "Unable to clear ranking source."
      });
    }
  }
);

/*
  Yahoo session status.

  This route does not contact Yahoo yet. It only
  reports whether temporary Yahoo information is
  currently present in server memory.
*/
app.get(
  "/api/yahoo/session/status",
  (req, res) => {
    res.json(
      getYahooSessionStatus()
    );
  }
);

/*
  Explicitly clear any temporary Yahoo information.

  Later, the Disconnect Yahoo button in the browser
  can call this endpoint.
*/
app.delete(
  "/api/yahoo/session",
  (req, res) => {
    clearYahooSession();

    res.json({
      message:
        "Temporary Yahoo session data was cleared.",
      ...getYahooSessionStatus()
    });
  }
);

app.patch(
  "/api/players/:playerId/status",
  (req, res) => {
    const { playerId } = req.params;

    const {
      status,
      draftedBy
    } = req.body;

    const allowedStatuses = [
      "available",
      "drafted"
    ];

    if (
      !allowedStatuses.includes(status)
    ) {
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
    `Benchwarmers Fantasy Assistant ` +
    `is running at ` +
    `http://localhost:${PORT}`
  );
});