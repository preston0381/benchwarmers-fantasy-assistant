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
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

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

function getTeams() {
  const teamRows = db
    .prepare(`
      SELECT id, owner, name
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
        player => player.fantasyTeamId === team.id
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

function getDraftPlayers() {
  return db
    .prepare(`
      SELECT
        id,
        name,
        position,
        nfl_team AS nflTeam,
        bye_week AS byeWeek,
        status,
        drafted_by AS draftedBy,
        rank,
        notes
      FROM players
      ORDER BY
        CASE
          WHEN rank IS NULL THEN 1
          ELSE 0
        END,
        rank,
        name
    `)
    .all();
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
      notes
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
      ?
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
  const updateTransaction = db.transaction(() => {
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
          rank,
          notes
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
      `).run(draftedBy, playerId);

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

    return db
      .prepare(`
        SELECT
          id,
          name,
          position,
          nfl_team AS nflTeam,
          bye_week AS byeWeek,
          status,
          drafted_by AS draftedBy,
          rank,
          notes
        FROM players
        WHERE id = ?
      `)
      .get(playerId);
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
    Array.isArray(player.fantasy_positions)
      ? player.fantasy_positions
      : [];

  const matchingFantasyPosition =
    fantasyPositions.find(position =>
      allowedPositions.has(position)
    );

  if (matchingFantasyPosition) {
    return matchingFantasyPosition;
  }

  if (allowedPositions.has(player.position)) {
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

function importSleeperPlayers(sleeperPlayers) {
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
      usableEntries.map(([playerId]) =>
        String(playerId)
      )
    );

  const findPlayer = db.prepare(`
    SELECT
      id,
      status,
      drafted_by AS draftedBy,
      rank,
      notes
    FROM players
    WHERE id = ?
  `);

  const deletePlayer = db.prepare(`
    DELETE FROM players
    WHERE id = ?
      AND status = 'available'
      AND drafted_by IS NULL
      AND rank IS NULL
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
      notes
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
      ''
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

      for (const playerId of sleeperIds) {
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

  const result = importTransaction();

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

module.exports = {
  db,
  getTeams,
  addPlayer,
  removePlayer,
  getDraftPlayers,
  createDraftPlayer,
  updateDraftPlayerStatus,
  importSleeperPlayers,
  getLastSleeperRefresh
};