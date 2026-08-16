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
  Draft recommendation engine.

  Maximum score = 100.

  Base value = 95 points maximum:
  50 points: rank value
  25 points: positional value
  20 points: roster need

  Draft urgency = 5 points maximum:
  dynamic positional scarcity

  The five-point urgency cap is the guardrail.
  Scarcity can break a close call, but it cannot
  overcome a player who is more than five base-value
  points better.

  Sleeper signal remains informational only.
*/
const RECOMMENDATION_WEIGHTS = {
  rankValue: 50,
  positionalValue: 25,
  rosterNeed: 20,
  urgencyAdjustment: 5
};

const SCARCITY_SIGNAL_MAX = 15;

/*
  Position-level scarcity alert thresholds.

  These alerts are informational only and do not
  directly change recommendation scores.
*/
const POSITION_SCARCITY_ALERT_THRESHOLDS = {
  Critical: 10,
  High: 6,
  Medium: 3
};

/*
  League-specific positional value.

  QB receives the full positional score because
  The Benchwarmers has quarterback-friendly scoring:
  6-point passing TDs and 1 point per 20 pass yards.
*/
const POSITION_VALUE_POINTS = {
  QB: 25,
  RB: 24,
  WR: 23,
  TE: 18,
  K: 5,
  DEF: 5
};

const POSITION_TARGETS = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  K: 1,
  DEF: 1
};

/*
  Scarcity is currently limited to positions where
  draft runs and talent cliffs are strategically
  meaningful.

  Kicker and defense will not receive scarcity
  bonuses in this version.
*/
const SCARCITY_POSITIONS =
  new Set([
    "QB",
    "RB",
    "WR",
    "TE"
  ]);

/*
  Yahoo live-data layer.

  Yahoo Fantasy information remains temporary and
  is held only in server memory.
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

function getPlayerRank(
  player
) {
  const rank =
    player.combinedRank ??
    player.rank;

  if (
    !Number.isFinite(rank) ||
    rank <= 0
  ) {
    return null;
  }

  return rank;
}

/*
  Rank 1 receives all 50 rank-value points.

  The 1.7 curve keeps the top of the board valuable
  while creating a faster decline farther down.
*/
function calculateRankValue(
  combinedRank,
  fallbackRank
) {
  const rank =
    combinedRank ??
    fallbackRank;

  if (
    !Number.isFinite(rank) ||
    rank <= 0
  ) {
    return 0;
  }

  const maxRank = 240;

  if (rank >= maxRank) {
    return 0;
  }

  const normalizedRank =
    (rank - 1) /
    (maxRank - 1);

  const curvedPercentage =
    Math.pow(
      1 - normalizedRank,
      1.7
    );

  return Number(
    (
      RECOMMENDATION_WEIGHTS.rankValue *
      curvedPercentage
    ).toFixed(1)
  );
}

function calculatePositionalValue(
  position
) {
  const normalizedPosition =
    String(position || "")
      .trim()
      .toUpperCase();

  return (
    POSITION_VALUE_POINTS[
      normalizedPosition
    ] ?? 0
  );
}

function countRosterPosition(
  roster,
  position
) {
  const normalizedPosition =
    String(position || "")
      .trim()
      .toUpperCase();

  return roster.filter(
    player =>
      String(player.position || "")
        .trim()
        .toUpperCase() ===
      normalizedPosition
  ).length;
}

function calculateRosterNeed(
  roster,
  position
) {
  const normalizedPosition =
    String(position || "")
      .trim()
      .toUpperCase();

  const target =
    POSITION_TARGETS[
      normalizedPosition
    ];

  if (!target) {
    return 0;
  }

  const currentCount =
    countRosterPosition(
      roster,
      normalizedPosition
    );

  if (currentCount >= target) {
    return 0;
  }

  const remainingNeed =
    target - currentCount;

  const needPercentage =
    remainingNeed / target;

  return Number(
    (
      RECOMMENDATION_WEIGHTS.rosterNeed *
      needPercentage
    ).toFixed(1)
  );
}

/*
  Dynamic scarcity.

  This examines ONLY players who are still available.

  Two things create scarcity:

  1. Talent cliff:
     How far is the next available player at the
     same position?

  2. Remaining alternatives:
     How many similarly ranked players at that
     position are still available nearby?

  As players are drafted, both can change.
*/
function calculateScarcityValue(
  player,
  availablePlayers
) {
  const position =
    String(player.position || "")
      .trim()
      .toUpperCase();

  if (
    !SCARCITY_POSITIONS.has(
      position
    )
  ) {
    return {
      scarcityValue: 0,
      scarcityLabel: "None",
      nextPositionRank: null,
      positionRankRemaining: null,
      nearbyAlternatives: null
    };
  }

  const playerRank =
    getPlayerRank(player);

  if (!playerRank) {
    return {
      scarcityValue: 0,
      scarcityLabel: "Unknown",
      nextPositionRank: null,
      positionRankRemaining: null,
      nearbyAlternatives: null
    };
  }

  const positionPlayers =
    availablePlayers
      .filter(candidate => {
        const candidatePosition =
          String(
            candidate.position || ""
          )
            .trim()
            .toUpperCase();

        return (
          candidatePosition ===
            position &&
          getPlayerRank(candidate)
        );
      })
      .sort(
        (a, b) =>
          getPlayerRank(a) -
          getPlayerRank(b)
      );

  const playerIsAvailable =
    positionPlayers.some(
      candidate =>
        candidate.id === player.id
    );

  if (!playerIsAvailable) {
    return {
      scarcityValue: 0,
      scarcityLabel: "None",
      nextPositionRank: null,
      positionRankRemaining: null,
      nearbyAlternatives: null
    };
  }

  /*
    Players with the same overall rank belong to
    the same tier.

    Everyone in that tier should see the same
    cliff behind the tier.
  */
  const tierPlayers =
    positionPlayers.filter(
      candidate =>
        getPlayerRank(candidate) ===
        playerRank
    );

  const playersAheadOfTier =
    positionPlayers.filter(
      candidate =>
        getPlayerRank(candidate) <
        playerRank
    );

  const positionRankRemaining =
    playersAheadOfTier.length + 1;

  /*
    Find the first player BELOW the entire current
    tier rather than simply the next player in the
    sorted list.

    This means tied players share the same cliff.
  */
  const playersBelowTier =
    positionPlayers.filter(
      candidate =>
        getPlayerRank(candidate) >
        playerRank
    );

  const nextPlayer =
    playersBelowTier[0] ?? null;

  const nextPositionRank =
    nextPlayer
      ? getPlayerRank(nextPlayer)
      : null;

  const rankGap =
    nextPositionRank
      ? Math.max(
          0,
          nextPositionRank -
            playerRank
        )
      : 25;

  /*
    Maximum 9 scarcity-signal points from the
    talent cliff.

    A gap of 20 ranks or more receives the full
    cliff component.
  */
  const cliffPoints =
    9 *
    Math.min(
      rankGap / 20,
      1
    );

  /*
    Count alternatives within the same tier plus
    same-position players no more than 12 overall
    ranking spots below this tier.
  */
  const sameTierAlternatives =
    Math.max(
      tierPlayers.length - 1,
      0
    );

  const lowerNearbyAlternatives =
    playersBelowTier.filter(
      candidate => {
        const candidateRank =
          getPlayerRank(candidate);

        return (
          candidateRank <=
          playerRank + 12
        );
      }
    ).length;

  const nearbyAlternatives =
    sameTierAlternatives +
    lowerNearbyAlternatives;

  /*
    Maximum 4 scarcity-signal points when
    alternatives are scarce.

    Zero alternatives = 4 points.
    Four or more alternatives = zero.
  */
  const alternativePoints =
    4 *
    Math.max(
      0,
      1 -
        (
          Math.min(
            nearbyAlternatives,
            4
          ) / 4
        )
    );

  /*
    Maximum 2 scarcity-signal points for being in
    one of the best remaining positional tiers.
  */
  let remainingPositionPoints = 0;

  if (positionRankRemaining === 1) {
    remainingPositionPoints = 2;
  } else if (
    positionRankRemaining === 2
  ) {
    remainingPositionPoints = 1.3;
  } else if (
    positionRankRemaining === 3
  ) {
    remainingPositionPoints = 0.7;
  }

  /*
    Prevent deep players from receiving huge
    scarcity signals merely because the position
    has become thin.
  */
  const qualityMultiplier =
    Math.max(
      0.35,
      1 -
        (
          Math.max(
            playerRank - 1,
            0
          ) / 180
        )
    );

  const rawScarcity =
    cliffPoints +
    alternativePoints +
    remainingPositionPoints;

  const scarcityValue =
    Number(
      Math.min(
        SCARCITY_SIGNAL_MAX,
        rawScarcity *
          qualityMultiplier
      ).toFixed(1)
    );

  let scarcityLabel = "Low";

  if (scarcityValue >= 10) {
    scarcityLabel = "Critical";
  } else if (
    scarcityValue >= 6
  ) {
    scarcityLabel = "High";
  } else if (
    scarcityValue >= 3
  ) {
    scarcityLabel = "Medium";
  }

  return {
    scarcityValue,
    scarcityLabel,
    nextPositionRank,
    positionRankRemaining,
    nearbyAlternatives
  };
}

/*
  Position-level scarcity alerts.

  These alerts are informational only.
  They do not change recommendation scores.
*/
function calculatePositionScarcityAlerts(
  availablePlayers
) {
  const alerts = [];

  for (const position of SCARCITY_POSITIONS) {
    const positionPlayers =
      availablePlayers
        .filter(player => {
          const playerPosition =
            String(player.position || "")
              .trim()
              .toUpperCase();

          return (
            playerPosition === position &&
            getPlayerRank(player)
          );
        })
        .sort(
          (a, b) =>
            getPlayerRank(a) -
            getPlayerRank(b)
        );

    if (positionPlayers.length === 0) {
      continue;
    }

    const bestAvailable =
      positionPlayers[0];

    const scarcity =
      calculateScarcityValue(
        bestAvailable,
        availablePlayers
      );

    let alertLevel = "Low";

    if (
      scarcity.scarcityValue >=
      POSITION_SCARCITY_ALERT_THRESHOLDS.Critical
    ) {
      alertLevel = "Critical";
    } else if (
      scarcity.scarcityValue >=
      POSITION_SCARCITY_ALERT_THRESHOLDS.High
    ) {
      alertLevel = "High";
    } else if (
      scarcity.scarcityValue >=
      POSITION_SCARCITY_ALERT_THRESHOLDS.Medium
    ) {
      alertLevel = "Medium";
    }

    alerts.push({
      position,
      alertLevel,
      scarcityValue:
        scarcity.scarcityValue,
      bestAvailablePlayer:
        bestAvailable.name,
      bestAvailableRank:
        getPlayerRank(bestAvailable),
      nextPositionRank:
        scarcity.nextPositionRank,
      nearbyAlternatives:
        scarcity.nearbyAlternatives
    });
  }

  return alerts;
}

/*
  Convert the larger 0-15 scarcity signal into a
  much smaller 0-5 draft-urgency adjustment.

  This is the scoring guardrail.

  Scarcity remains useful information, but it can
  never add more than five points to a player.
*/
function calculateUrgencyAdjustment(
  scarcityValue
) {
  if (
    !Number.isFinite(scarcityValue) ||
    scarcityValue <= 0
  ) {
    return 0;
  }

  const urgencyPercentage =
    Math.min(
      scarcityValue /
        SCARCITY_SIGNAL_MAX,
      1
    );

  return Number(
    (
      RECOMMENDATION_WEIGHTS
        .urgencyAdjustment *
      urgencyPercentage
    ).toFixed(1)
  );
}

/*
  Sleeper signal remains completely separate from
  recommendation scoring.
*/
function calculateSleeperSignal(
  fantasyProsRank,
  pfnRank
) {
  if (
    !Number.isFinite(
      fantasyProsRank
    ) ||
    !Number.isFinite(
      pfnRank
    )
  ) {
    return {
      sleeperSignal: "Unknown",
      rankingGap: null
    };
  }

  const rankingGap =
    Math.abs(
      fantasyProsRank -
      pfnRank
    );

  let sleeperSignal =
    "Low";

  if (rankingGap >= 16) {
    sleeperSignal = "High";
  } else if (rankingGap >= 6) {
    sleeperSignal = "Medium";
  }

  return {
    sleeperSignal,
    rankingGap
  };
}

function getRecommendationLabel(
  score
) {
  if (score >= 95) {
    return "Elite pick";
  }

  if (score >= 88) {
    return "Strong value";
  }

  if (score >= 78) {
    return "Good pick";
  }

  if (score >= 65) {
    return "Reach territory";
  }

  return "Probably wait";
}

function calculateRecommendation(
  player,
  roster,
  availablePlayers
) {
  const rankValue =
    calculateRankValue(
      player.combinedRank,
      player.rank
    );

  const positionalValue =
    calculatePositionalValue(
      player.position
    );

  const rosterNeed =
    calculateRosterNeed(
      roster,
      player.position
    );

  const baseValue =
    Number(
      (
        rankValue +
        positionalValue +
        rosterNeed
      ).toFixed(1)
    );

  const scarcity =
    calculateScarcityValue(
      player,
      availablePlayers
    );

  const urgencyAdjustment =
    calculateUrgencyAdjustment(
      scarcity.scarcityValue
    );

  const recommendationScore =
    Number(
      Math.min(
        100,
        baseValue +
          urgencyAdjustment
      ).toFixed(1)
    );

  const sleeper =
    calculateSleeperSignal(
      player.fantasyProsRank,
      player.pfnRank
    );

  return {
    recommendationScore,

    recommendationLabel:
      getRecommendationLabel(
        recommendationScore
      ),

    baseValue,

    urgencyAdjustment,

    scarcityValue:
      scarcity.scarcityValue,

    scarcityLabel:
      scarcity.scarcityLabel,

    positionRankRemaining:
      scarcity.positionRankRemaining,

    nextPositionRank:
      scarcity.nextPositionRank,

    nearbyAlternatives:
      scarcity.nearbyAlternatives,

    sleeperSignal:
      sleeper.sleeperSignal,

    rankingGap:
      sleeper.rankingGap,

    recommendationBreakdown: {
      rankValue,
      positionalValue,
      rosterNeed,
      baseValue,
      urgencyAdjustment,
      scarcityValue:
        scarcity.scarcityValue
    }
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

/*
  Draft-board player endpoint.

  Recommendation scores are recalculated on every
  request using the currently available player pool.

  Preston is the default recommendation team.
*/
app.get("/api/players", (req, res) => {
  try {
    const requestedTeamId =
      String(
        req.query.team || "preston"
      )
        .trim()
        .toLowerCase();

    const teams =
      getTeams();

    const recommendationTeam =
      teams[requestedTeamId] ??
      teams.preston;

    const roster =
      recommendationTeam?.roster ??
      [];

    const players =
      getDraftPlayers();

    const availablePlayers =
      players.filter(
        player =>
          player.status === "available"
      );

    const playersWithRecommendations =
      players.map(player => ({
        ...player,
        ...calculateRecommendation(
          player,
          roster,
          availablePlayers
        )
      }));

    res.json(
      playersWithRecommendations
    );
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

/*
  Position scarcity alerts.

  This is separate from the recommendation ranking.
  It gives the draft UI a simple way to warn that
  QB, RB, WR, or TE is beginning to thin out.
*/
app.get(
  "/api/players/scarcity-alerts",
  (req, res) => {
    try {
      const players =
        getDraftPlayers();

      const availablePlayers =
        players.filter(
          player =>
            player.status === "available"
        );

      const alerts =
        calculatePositionScarcityAlerts(
          availablePlayers
        );

      res.json(alerts);
    } catch (error) {
      console.error(
        "Unable to calculate scarcity alerts:",
        error
      );

      res.status(500).json({
        error:
          "Unable to calculate scarcity alerts."
      });
    }
  }
);

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
  Clear temporary Yahoo session data.
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