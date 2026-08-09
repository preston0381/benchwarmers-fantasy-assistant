const path = require("path");
const Database = require("better-sqlite3");

const DB_FILE = path.join(__dirname, "benchwarmers.db");
const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS fantasy_teams (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roster_players (
    id TEXT PRIMARY KEY,
    fantasy_team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT NOT NULL,
    nfl_team TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (fantasy_team_id)
      REFERENCES fantasy_teams(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position TEXT NOT NULL,
    nfl_team TEXT,
    bye_week INTEGER,
    status TEXT NOT NULL DEFAULT 'available',
    drafted_by TEXT,
    rank INTEGER,
    notes TEXT,
    fantasypros_rank INTEGER,
    pfn_rank INTEGER
  );

  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

function columnExists(tableName, columnName) {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all();

  return columns.some(
    column => column.name === columnName
  );
}

if (!columnExists("players", "fantasypros_rank")) {
  db.exec(`
    ALTER TABLE players
    ADD COLUMN fantasypros_rank INTEGER
  `);
}

if (!columnExists("players", "pfn_rank")) {
  db.exec(`
    ALTER TABLE players
    ADD COLUMN pfn_rank INTEGER
  `);
}

/*
  Migrate any values from the old FantasyData column
  into the new PFN column. This is safe even if no
  FantasyData rankings were ever imported.
*/
if (columnExists("players", "fantasydata_rank")) {
  db.exec(`
    UPDATE players
    SET pfn_rank = fantasydata_rank
    WHERE pfn_rank IS NULL
      AND fantasydata_rank IS NOT NULL
  `);
}

/*
  Migrate the old FantasyData import timestamp if one
  exists and PFN does not already have a timestamp.
*/
const oldFantasyDataMetadata = db
  .prepare(`
    SELECT value
    FROM app_metadata
    WHERE key = 'fantasydata_rankings_last_import'
  `)
  .get();

const existingPfnMetadata = db
  .prepare(`
    SELECT value
    FROM app_metadata
    WHERE key = 'pfn_rankings_last_import'
  `)
  .get();

if (
  oldFantasyDataMetadata &&
  !existingPfnMetadata
) {
  db.prepare(`
    INSERT INTO app_metadata (
      key,
      value
    )
    VALUES (
      'pfn_rankings_last_import',
      ?
    )
  `).run(oldFantasyDataMetadata.value);
}

const upsertTeam = db.prepare(`
  INSERT INTO fantasy_teams (id, owner, name)
  VALUES (@id, @owner, @name)
  ON CONFLICT(id) DO UPDATE SET
    owner = excluded.owner,
    name = excluded.name
`);

upsertTeam.run({
  id: "preston",
  owner: "Preston",
  name: "That's What She Said"
});

upsertTeam.run({
  id: "trena",
  owner: "Trena",
  name: "Tinkerbell"
});

function calculateCombinedRank(
  fantasyProsRank,
  pfnRank
) {
  const validRanks = [
    fantasyProsRank,
    pfnRank
  ].filter(
    rank =>
      Number.isInteger(rank) &&
      rank > 0
  );

  if (validRanks.length === 0) {
    return null;
  }

  const total = validRanks.reduce(
    (sum, rank) => sum + rank,
    0
  );

  return Number(
    (total / validRanks.length).toFixed(1)
  );
}

function getTeams() {
  const teamRows = db
    .prepare(`
      SELECT
        id,
        owner,
        name
      FROM fantasy_teams
      ORDER BY id
    `)
    .all();

  const playerRows = db
    .prepare(`
      SELECT
        id,
        fantasy_team_id AS fantasyTeamId,
        name,
        position,
        nfl_team AS nflTeam
      FROM roster_players
      ORDER BY created_at, name
    `)
    .all();

  const teams = {};

  for (const team of teamRows) {
    teams[team.id] = {
      owner: team.owner,
      name: team.name,
      roster: playerRows.filter(
        player =>
          player.fantasyTeamId === team.id
      )
    };
  }

  return teams;
}

function addPlayer(teamId, player) {
  const team = db
    .prepare(`
      SELECT id
      FROM fantasy_teams
      WHERE id = ?
    `)
    .get(teamId);

  if (!team) {
    return null;
  }

  db.prepare(`
    INSERT INTO roster_players (
      id,
      fantasy_team_id,
      name,
      position,
      nfl_team
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    player.id,
    teamId,
    player.name,
    player.position,
    player.nflTeam || ""
  );

  return player;
}

function removePlayer(teamId, playerId) {
  const player = db
    .prepare(`
      SELECT
        id,
        name,
        position,
        nfl_team AS nflTeam
      FROM roster_players
      WHERE id = ?
        AND fantasy_team_id = ?
    `)
    .get(playerId, teamId);

  if (!player) {
    return null;
  }

  db.prepare(`
    DELETE FROM roster_players
    WHERE id = ?
      AND fantasy_team_id = ?
  `).run(playerId, teamId);

  return player;
}

function mapDraftPlayer(player) {
  const combinedRank =
    calculateCombinedRank(
      player.fantasyProsRank,
      player.pfnRank
    );

  return {
    id: player.id,
    name: player.name,
    position: player.position,
    nflTeam: player.nflTeam,
    byeWeek: player.byeWeek,
    status: player.status,
    draftedBy: player.draftedBy,
    notes: player.notes,
    fantasyProsRank:
      player.fantasyProsRank,
    pfnRank:
      player.pfnRank,
    combinedRank,
    rank:
      combinedRank ??
      player.legacyRank ??
      null
  };
}

function getDraftPlayers() {
  const players = db
    .prepare(`
      SELECT
        id,
        name,
        position,
        nfl_team AS nflTeam,
        bye_week AS byeWeek,
        status,
        drafted_by AS draftedBy,
        rank AS legacyRank,
        notes,
        fantasypros_rank AS fantasyProsRank,
        pfn_rank AS pfnRank
      FROM players
    `)
    .all();

  return players
    .map(mapDraftPlayer)
    .sort((a, b) => {
      const rankA =
        a.combinedRank ??
        a.rank ??
        Number.MAX_SAFE_INTEGER;

      const rankB =
        b.combinedRank ??
        b.rank ??
        Number.MAX_SAFE_INTEGER;

      if (rankA !== rankB) {
        return rankA - rankB;
      }

      return a.name.localeCompare(b.name);
    });
}

function createDraftPlayer(player) {
  db.prepare(`
    INSERT INTO players (
      id,
      name,
      position,
      nfl_team,
      bye_week,
      status,
      drafted_by,
      rank,
      notes,
      fantasypros_rank,
      pfn_rank
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      'available',
      NULL,
      ?,
      ?,
      NULL,
      NULL
    )
  `).run(
    player.id,
    player.name,
    player.position,
    player.nflTeam || "",
    player.byeWeek || null,
    player.rank || null,
    player.notes || ""
  );

  return player;
}

function updateDraftPlayerStatus(
  playerId,
  status,
  draftedBy = null
) {
  const updateTransaction =
    db.transaction(() => {
      const player = db
        .prepare(`
          SELECT
            id,
            name,
            position,
            nfl_team AS nflTeam,
            bye_week AS byeWeek,
            status,
            drafted_by AS draftedBy,
            rank AS legacyRank,
            notes,
            fantasypros_rank AS fantasyProsRank,
            pfn_rank AS pfnRank
          FROM players
          WHERE id = ?
        `)
        .get(playerId);

      if (!player) {
        return null;
      }

      db.prepare(`
        DELETE FROM roster_players
        WHERE id = ?
      `).run(playerId);

      if (status === "drafted") {
        db.prepare(`
          UPDATE players
          SET
            status = 'drafted',
            drafted_by = ?
          WHERE id = ?
        `).run(
          draftedBy,
          playerId
        );

        if (
          draftedBy === "preston" ||
          draftedBy === "trena"
        ) {
          db.prepare(`
            INSERT INTO roster_players (
              id,
              fantasy_team_id,
              name,
              position,
              nfl_team
            )
            VALUES (?, ?, ?, ?, ?)
          `).run(
            player.id,
            draftedBy,
            player.name,
            player.position,
            player.nflTeam || ""
          );
        }
      } else {
        db.prepare(`
          UPDATE players
          SET
            status = 'available',
            drafted_by = NULL
          WHERE id = ?
        `).run(playerId);
      }

      const updatedPlayer = db
        .prepare(`
          SELECT
            id,
            name,
            position,
            nfl_team AS nflTeam,
            bye_week AS byeWeek,
            status,
            drafted_by AS draftedBy,
            rank AS legacyRank,
            notes,
            fantasypros_rank AS fantasyProsRank,
            pfn_rank AS pfnRank
          FROM players
          WHERE id = ?
        `)
        .get(playerId);

      return mapDraftPlayer(updatedPlayer);
    });

  return updateTransaction();
}

function setMetadata(key, value) {
  db.prepare(`
    INSERT INTO app_metadata (
      key,
      value
    )
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value
  `).run(key, value);
}

function getMetadata(key) {
  const row = db
    .prepare(`
      SELECT value
      FROM app_metadata
      WHERE key = ?
    `)
    .get(key);

  return row ? row.value : null;
}

function getLastSleeperRefresh() {
  return getMetadata(
    "sleeper_players_last_refresh"
  );
}

function getLastRankingImport(source = null) {
  if (source === "fantasypros") {
    return getMetadata(
      "fantasypros_rankings_last_import"
    );
  }

  if (source === "pfn") {
    return getMetadata(
      "pfn_rankings_last_import"
    );
  }

  return getMetadata(
    "player_rankings_last_import"
  );
}

function buildSleeperPlayerName(player) {
  if (
    player.full_name &&
    player.full_name.trim()
  ) {
    return player.full_name.trim();
  }

  const firstName = player.first_name
    ? player.first_name.trim()
    : "";

  const lastName = player.last_name
    ? player.last_name.trim()
    : "";

  const combinedName =
    `${firstName} ${lastName}`.trim();

  if (combinedName) {
    return combinedName;
  }

  if (
    player.position === "DEF" &&
    player.team
  ) {
    return `${player.team} Defense`;
  }

  return "";
}

function chooseFantasyPosition(player) {
  const allowedPositions = new Set([
    "QB",
    "RB",
    "WR",
    "TE",
    "K",
    "DEF"
  ]);

  const fantasyPositions =
    Array.isArray(
      player.fantasy_positions
    )
      ? player.fantasy_positions
      : [];

  const matchingFantasyPosition =
    fantasyPositions.find(position =>
      allowedPositions.has(position)
    );

  if (matchingFantasyPosition) {
    return matchingFantasyPosition;
  }

  if (
    allowedPositions.has(
      player.position
    )
  ) {
    return player.position;
  }

  return null;
}

function isUsableSleeperPlayer(player) {
  if (!player) {
    return false;
  }

  if (player.active === false) {
    return false;
  }

  if (!player.team) {
    return false;
  }

  const position =
    chooseFantasyPosition(player);

  if (!position) {
    return false;
  }

  const name =
    buildSleeperPlayerName(player);

  if (!name) {
    return false;
  }

  return true;
}

function importSleeperPlayers(
  sleeperPlayers
) {
  if (
    !sleeperPlayers ||
    typeof sleeperPlayers !== "object" ||
    Array.isArray(sleeperPlayers)
  ) {
    throw new TypeError(
      "Sleeper player data must be an object map."
    );
  }

  const entries =
    Object.entries(sleeperPlayers);

  const usableEntries =
    entries.filter(([, player]) =>
      isUsableSleeperPlayer(player)
    );

  const sleeperIds =
    entries.map(([playerId]) =>
      String(playerId)
    );

  const usableIds =
    new Set(
      usableEntries.map(
        ([playerId]) =>
          String(playerId)
      )
    );

  const findPlayer = db.prepare(`
    SELECT
      id,
      status,
      drafted_by AS draftedBy,
      rank,
      notes,
      fantasypros_rank AS fantasyProsRank,
      pfn_rank AS pfnRank
    FROM players
    WHERE id = ?
  `);

  const deletePlayer = db.prepare(`
    DELETE FROM players
    WHERE id = ?
      AND status = 'available'
      AND drafted_by IS NULL
      AND rank IS NULL
      AND fantasypros_rank IS NULL
      AND pfn_rank IS NULL
      AND (
        notes IS NULL OR
        notes = ''
      )
  `);

  const upsertPlayer = db.prepare(`
    INSERT INTO players (
      id,
      name,
      position,
      nfl_team,
      bye_week,
      status,
      drafted_by,
      rank,
      notes,
      fantasypros_rank,
      pfn_rank
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      NULL,
      'available',
      NULL,
      NULL,
      '',
      NULL,
      NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      position = excluded.position,
      nfl_team = excluded.nfl_team
  `);

  const importTransaction =
    db.transaction(() => {
      let imported = 0;
      let removed = 0;
      let preserved = 0;

      for (
        const playerId of sleeperIds
      ) {
        if (usableIds.has(playerId)) {
          continue;
        }

        const existingPlayer =
          findPlayer.get(playerId);

        if (!existingPlayer) {
          continue;
        }

        const result =
          deletePlayer.run(playerId);

        if (result.changes > 0) {
          removed += 1;
        } else {
          preserved += 1;
        }
      }

      for (
        const [
          playerId,
          sleeperPlayer
        ] of usableEntries
      ) {
        const position =
          chooseFantasyPosition(
            sleeperPlayer
          );

        const name =
          buildSleeperPlayerName(
            sleeperPlayer
          );

        upsertPlayer.run(
          String(playerId),
          name,
          position,
          sleeperPlayer.team
        );

        imported += 1;
      }

      return {
        imported,
        removed,
        preserved,
        skipped:
          entries.length -
          usableEntries.length
      };
    });

  const result =
    importTransaction();

  const refreshedAt =
    new Date().toISOString();

  setMetadata(
    "sleeper_players_last_refresh",
    refreshedAt
  );

  const totalPlayers = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM players
    `)
    .get().count;

  return {
    ...result,
    refreshedAt,
    totalPlayers
  };
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function createNormalizedRow(row) {
  const normalizedRow = {};

  for (
    const [key, value] of
    Object.entries(row)
  ) {
    normalizedRow[
      normalizeHeader(key)
    ] = value;
  }

  return normalizedRow;
}

function getRowValue(row, aliases) {
  for (const alias of aliases) {
    const normalizedAlias =
      normalizeHeader(alias);

    if (
      Object.prototype
        .hasOwnProperty.call(
          row,
          normalizedAlias
        )
    ) {
      return row[
        normalizedAlias
      ];
    }
  }

  return "";
}

function normalizePlayerName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /\b(jr|sr|ii|iii|iv|v)\b/g,
      ""
    )
    .replace(/[^a-z0-9]/g, "");
}

function normalizePosition(value) {
  const position =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    position === "DST" ||
    position === "D/ST" ||
    position === "D"
  ) {
    return "DEF";
  }

  return position;
}

function normalizeTeam(value) {
  const team =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, "");

  const teamAliases = {
    JAC: "JAX",
    WSH: "WAS",
    LA: "LAR",
    GBP: "GB",
    KCC: "KC",
    NEP: "NE",
    NOS: "NO",
    SFO: "SF",
    TBB: "TB"
  };

  return teamAliases[team] || team;
}

function parsePositiveInteger(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const number =
    Number.parseInt(
      String(value).trim(),
      10
    );

  if (
    !Number.isInteger(number) ||
    number < 1
  ) {
    return null;
  }

  return number;
}

function buildPlayerLookup(players) {
  const byName = new Map();
  const byNameAndPosition =
    new Map();

  for (const player of players) {
    const normalizedName =
      normalizePlayerName(
        player.name
      );

    const normalizedPosition =
      normalizePosition(
        player.position
      );

    const nameKey =
      normalizedName;

    const namePositionKey =
      `${normalizedName}|` +
      `${normalizedPosition}`;

    if (!byName.has(nameKey)) {
      byName.set(nameKey, []);
    }

    if (
      !byNameAndPosition.has(
        namePositionKey
      )
    ) {
      byNameAndPosition.set(
        namePositionKey,
        []
      );
    }

    byName
      .get(nameKey)
      .push(player);

    byNameAndPosition
      .get(namePositionKey)
      .push(player);
  }

  return {
    byName,
    byNameAndPosition
  };
}

function chooseRankingMatch(
  normalizedRow,
  playerLookup
) {
  const rawName = getRowValue(
    normalizedRow,
    [
      "player",
      "player name",
      "player_name",
      "name",
      "full name",
      "full_name"
    ]
  );

  const rawPosition = getRowValue(
    normalizedRow,
    [
      "position",
      "pos"
    ]
  );

  const rawTeam = getRowValue(
    normalizedRow,
    [
      "team",
      "nfl team",
      "nfl_team",
      "tm"
    ]
  );

  const normalizedName =
    normalizePlayerName(rawName);

  const normalizedPosition =
    normalizePosition(rawPosition);

  const normalizedTeam =
    normalizeTeam(rawTeam);

  if (!normalizedName) {
    return {
      status: "invalid",
      player: null
    };
  }

  let candidates = [];

  if (normalizedPosition) {
    const key =
      `${normalizedName}|` +
      `${normalizedPosition}`;

    candidates =
      playerLookup
        .byNameAndPosition
        .get(key) || [];
  }

  if (candidates.length === 0) {
    candidates =
      playerLookup
        .byName
        .get(normalizedName) || [];
  }

  if (
    normalizedTeam &&
    candidates.length > 1
  ) {
    const teamMatches =
      candidates.filter(
        player =>
          normalizeTeam(
            player.nflTeam
          ) === normalizedTeam
      );

    if (
      teamMatches.length > 0
    ) {
      candidates =
        teamMatches;
    }
  }

  if (candidates.length === 1) {
    return {
      status: "matched",
      player: candidates[0]
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      player: null
    };
  }

  return {
    status: "unmatched",
    player: null
  };
}

function validateRankingSource(source) {
  const normalizedSource =
    String(source || "")
      .trim()
      .toLowerCase();

  if (
    normalizedSource !==
      "fantasypros" &&
    normalizedSource !==
      "pfn"
  ) {
    throw new Error(
      "Ranking source must be fantasypros or pfn."
    );
  }

  return normalizedSource;
}

function importPlayerRankings(
  rankingRows,
  source = "fantasypros"
) {
  if (!Array.isArray(rankingRows)) {
    throw new TypeError(
      "Ranking data must be an array of CSV rows."
    );
  }

  const rankingSource =
    validateRankingSource(source);

  const players = db
    .prepare(`
      SELECT
        id,
        name,
        position,
        nfl_team AS nflTeam
      FROM players
    `)
    .all();

  const playerLookup =
    buildPlayerLookup(players);

  const rankColumn =
    rankingSource ===
      "fantasypros"
      ? "fantasypros_rank"
      : "pfn_rank";

  const updatePlayerRanking =
    db.prepare(`
      UPDATE players
      SET
        ${rankColumn} = ?,
        bye_week =
          COALESCE(?, bye_week)
      WHERE id = ?
    `);

  const importTransaction =
    db.transaction(rows => {
      let matched = 0;
      let unmatched = 0;
      let ambiguous = 0;
      let invalid = 0;

      const unmatchedPlayers = [];
      const ambiguousPlayers = [];

      for (
        const originalRow of rows
      ) {
        const row =
          createNormalizedRow(
            originalRow
          );

        const rawName =
          getRowValue(
            row,
            [
              "player",
              "player name",
              "player_name",
              "name",
              "full name",
              "full_name"
            ]
          );

        const rawRank =
          getRowValue(
            row,
            [
              "rank",
              "overall",
              "overall rank",
              "overall_rank",
              "rk",
              "ecr"
            ]
          );

        const rawByeWeek =
          getRowValue(
            row,
            [
              "bye",
              "bye week",
              "bye_week"
            ]
          );

        const rank =
          parsePositiveInteger(
            rawRank
          );

        if (!rawName || !rank) {
          invalid += 1;
          continue;
        }

        const match =
          chooseRankingMatch(
            row,
            playerLookup
          );

        if (
          match.status === "matched" &&
          match.player
        ) {
          const byeWeek =
            parsePositiveInteger(
              rawByeWeek
            );

          updatePlayerRanking.run(
            rank,
            byeWeek,
            match.player.id
          );

          matched += 1;
          continue;
        }

        if (
          match.status ===
          "ambiguous"
        ) {
          ambiguous += 1;

          if (
            ambiguousPlayers.length <
            20
          ) {
            ambiguousPlayers.push(
              String(rawName).trim()
            );
          }

          continue;
        }

        if (
          match.status ===
          "unmatched"
        ) {
          unmatched += 1;

          if (
            unmatchedPlayers.length <
            20
          ) {
            unmatchedPlayers.push(
              String(rawName).trim()
            );
          }

          continue;
        }

        invalid += 1;
      }

      return {
        matched,
        unmatched,
        ambiguous,
        invalid,
        unmatchedPlayers,
        ambiguousPlayers
      };
    });

  const result =
    importTransaction(
      rankingRows
    );

  const importedAt =
    new Date().toISOString();

  setMetadata(
    `${rankingSource}_rankings_last_import`,
    importedAt
  );

  setMetadata(
    "player_rankings_last_import",
    importedAt
  );

  const rankedPlayers =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM players
      WHERE ${rankColumn}
        IS NOT NULL
    `)
      .get()
      .count;

  return {
    ...result,
    source: rankingSource,
    rowsReceived:
      rankingRows.length,
    rankedPlayers,
    importedAt
  };
}

function getRankingStatus() {
  const counts = db
    .prepare(`
      SELECT
        COUNT(
          fantasypros_rank
        ) AS fantasyProsRankedPlayers,
        COUNT(
          pfn_rank
        ) AS pfnRankedPlayers
      FROM players
    `)
    .get();

  return {
    fantasyPros: {
      lastImport:
        getLastRankingImport(
          "fantasypros"
        ),
      rankedPlayers:
        counts.fantasyProsRankedPlayers
    },
    pfn: {
      lastImport:
        getLastRankingImport(
          "pfn"
        ),
      rankedPlayers:
        counts.pfnRankedPlayers
    }
  };
}

function clearRankingSource(source) {
  const rankingSource =
    validateRankingSource(source);

  const rankColumn =
    rankingSource ===
      "fantasypros"
      ? "fantasypros_rank"
      : "pfn_rank";

  const result = db
    .prepare(`
      UPDATE players
      SET ${rankColumn} = NULL
    `)
    .run();

  db.prepare(`
    DELETE FROM app_metadata
    WHERE key = ?
  `).run(
    `${rankingSource}_rankings_last_import`
  );

  return {
    source: rankingSource,
    clearedPlayers:
      result.changes
  };
}

module.exports = {
  db,
  getTeams,
  addPlayer,
  removePlayer,
  getDraftPlayers,
  createDraftPlayer,
  updateDraftPlayerStatus,
  importSleeperPlayers,
  getLastSleeperRefresh,
  importPlayerRankings,
  getLastRankingImport,
  getRankingStatus,
  clearRankingSource
};