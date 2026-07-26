const path = require("path");
const Database = require("better-sqlite3");

const DB_FILE = path.join(__dirname, "benchwarmers.db");
const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

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
    .prepare("SELECT id, owner, name FROM fantasy_teams ORDER BY id")
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
    .prepare("SELECT id FROM fantasy_teams WHERE id = ?")
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
      WHERE id = ? AND fantasy_team_id = ?
    `)
    .get(playerId, teamId);

  if (!player) {
    return null;
  }

  db.prepare(`
    DELETE FROM roster_players
    WHERE id = ? AND fantasy_team_id = ?
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
        CASE WHEN rank IS NULL THEN 1 ELSE 0 END,
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
    VALUES (?, ?, ?, ?, ?, 'available', NULL, ?, ?)
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

function updateDraftPlayerStatus(playerId, status, draftedBy = null) {
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

      if (draftedBy === "preston" || draftedBy === "trena") {
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

module.exports = {
  db,
  getTeams,
  addPlayer,
  removePlayer,
  getDraftPlayers,
  createDraftPlayer,
  updateDraftPlayerStatus
};