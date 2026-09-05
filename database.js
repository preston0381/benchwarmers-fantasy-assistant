const path = require("path");
const Database = require("better-sqlite3");

const DB_FILE = process.env.BENCHWARMERS_DB_FILE
  ? path.resolve(
      process.env.BENCHWARMERS_DB_FILE
    )
  : path.join(
      __dirname,
      "benchwarmers.db"
    );

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
    created_at TEXT NOT NULL
      DEFAULT CURRENT_TIMESTAMP,
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
    status TEXT NOT NULL
      DEFAULT 'available',
    drafted_by TEXT,
    rank INTEGER,
    notes TEXT,
    fantasypros_rank INTEGER,
    pfn_rank INTEGER,
    catalog_source TEXT NOT NULL
      DEFAULT 'sleeper_legacy',
    source_player_id TEXT,
    catalog_active INTEGER,
    catalog_status TEXT
  );

  CREATE TABLE IF NOT EXISTS player_rankings (
    player_id TEXT NOT NULL,
    source TEXT NOT NULL,
    rank INTEGER NOT NULL,
    tier INTEGER,
    position_rank INTEGER,
    bye_week INTEGER,
    upside_score REAL,
    bust_score REAL,
    sos_score REAL,
    ecr_vs_adp INTEGER,
    updated_at TEXT NOT NULL
      DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (
      player_id,
      source
    ),

    FOREIGN KEY (player_id)
      REFERENCES players(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS
    idx_player_rankings_source
  ON player_rankings(source);

  CREATE INDEX IF NOT EXISTS
    idx_player_rankings_rank
  ON player_rankings(rank);

  CREATE TABLE IF NOT EXISTS espn_injury_snapshot (
    player_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    player_name TEXT NOT NULL,
    team TEXT,
    position TEXT NOT NULL,
    status TEXT NOT NULL,
    estimated_return TEXT,
    injury_body_part TEXT,
    comment TEXT,
    comment_date TEXT,
    snapshot_imported_at TEXT NOT NULL,

    FOREIGN KEY (player_id)
      REFERENCES players(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

function columnExists(
  tableName,
  columnName
) {
  const columns = db
    .prepare(
      `PRAGMA table_info(${tableName})`
    )
    .all();

  return columns.some(
    column =>
      column.name === columnName
  );
}

const rankingSupplementalColumns = {
  tier: "INTEGER",
  position_rank: "INTEGER",
  bye_week: "INTEGER",
  upside_score: "REAL",
  bust_score: "REAL",
  sos_score: "REAL",
  ecr_vs_adp: "INTEGER"
};

const playerCatalogColumns = {
  catalog_source:
    "TEXT NOT NULL DEFAULT 'sleeper_legacy'",
  source_player_id: "TEXT",
  catalog_active: "INTEGER",
  catalog_status: "TEXT"
};

for (
  const [columnName, columnType]
  of Object.entries(
    playerCatalogColumns
  )
) {
  if (
    !columnExists(
      "players",
      columnName
    )
  ) {
    db.exec(`
      ALTER TABLE players
      ADD COLUMN ${columnName} ${columnType}
    `);
  }
}

db.exec(`
  UPDATE players
  SET source_player_id = id
  WHERE source_player_id IS NULL
    AND catalog_source IN (
      'sleeper',
      'sleeper_legacy'
    )
`);

for (
  const [columnName, columnType]
  of Object.entries(
    rankingSupplementalColumns
  )
) {
  if (
    !columnExists(
      "player_rankings",
      columnName
    )
  ) {
    db.exec(`
      ALTER TABLE player_rankings
      ADD COLUMN ${columnName} ${columnType}
    `);
  }
}

/*
  Older copies of the app may not have these
  columns. We leave them in place for backwards
  compatibility and migration only.

  New ranking imports will use player_rankings.
*/
if (
  !columnExists(
    "players",
    "fantasypros_rank"
  )
) {
  db.exec(`
    ALTER TABLE players
    ADD COLUMN fantasypros_rank INTEGER
  `);
}

if (
  !columnExists(
    "players",
    "pfn_rank"
  )
) {
  db.exec(`
    ALTER TABLE players
    ADD COLUMN pfn_rank INTEGER
  `);
}

/*
  Very old versions used fantasydata_rank.
  If it exists, migrate those values into
  pfn_rank first.
*/
if (
  columnExists(
    "players",
    "fantasydata_rank"
  )
) {
  db.exec(`
    UPDATE players
    SET pfn_rank = fantasydata_rank
    WHERE pfn_rank IS NULL
      AND fantasydata_rank IS NOT NULL
  `);
}

/*
  Migrate existing FantasyPros and PFN rankings
  from the legacy players columns into
  player_rankings exactly once.

  A metadata flag prevents cleared rankings from
  being restored from the legacy columns on a
  later app restart.
*/
const legacyRankingMigrationKey =
  "player_rankings_legacy_migrated_v1";

const legacyRankingMigration =
  db.prepare(`
    SELECT value
    FROM app_metadata
    WHERE key = ?
  `).get(
    legacyRankingMigrationKey
  );

if (!legacyRankingMigration) {
  const migrateLegacyRankings =
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO player_rankings (
          player_id,
          source,
          rank,
          updated_at
        )
        SELECT
          id,
          'fantasypros',
          fantasypros_rank,
          CURRENT_TIMESTAMP
        FROM players
        WHERE fantasypros_rank IS NOT NULL;

        INSERT OR IGNORE INTO player_rankings (
          player_id,
          source,
          rank,
          updated_at
        )
        SELECT
          id,
          'pfn',
          pfn_rank,
          CURRENT_TIMESTAMP
        FROM players
        WHERE pfn_rank IS NOT NULL;
      `);

      db.prepare(`
        INSERT INTO app_metadata (
          key,
          value
        )
        VALUES (
          ?,
          ?
        )
      `).run(
        legacyRankingMigrationKey,
        new Date().toISOString()
      );
    });

  migrateLegacyRankings();
}

/*
  Migrate old FantasyData timestamp if needed.
*/
const oldFantasyDataMetadata = db
  .prepare(`
    SELECT value
    FROM app_metadata
    WHERE key =
      'fantasydata_rankings_last_import'
  `)
  .get();

const existingPfnMetadata = db
  .prepare(`
    SELECT value
    FROM app_metadata
    WHERE key =
      'pfn_rankings_last_import'
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
  `).run(
    oldFantasyDataMetadata.value
  );
}

const upsertTeam = db.prepare(`
  INSERT INTO fantasy_teams (
    id,
    owner,
    name
  )
  VALUES (
    @id,
    @owner,
    @name
  )
  ON CONFLICT(id)
  DO UPDATE SET
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

  const total =
    validRanks.reduce(
      (sum, rank) =>
        sum + rank,
      0
    );

  return Number(
    (
      total /
      validRanks.length
    ).toFixed(1)
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
        fantasy_team_id
          AS fantasyTeamId,
        name,
        position,
        nfl_team AS nflTeam
      FROM roster_players
      ORDER BY
        created_at,
        name
    `)
    .all();

  const teams = {};

  for (const team of teamRows) {
    teams[team.id] = {
      owner: team.owner,
      name: team.name,
      roster:
        playerRows.filter(
          player =>
            player.fantasyTeamId ===
            team.id
        )
    };
  }

  return teams;
}

function addPlayer(
  teamId,
  player
) {
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
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?
    )
  `).run(
    player.id,
    teamId,
    player.name,
    player.position,
    player.nflTeam || ""
  );

  return player;
}

function removePlayer(
  teamId,
  playerId
) {
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
    .get(
      playerId,
      teamId
    );

  if (!player) {
    return null;
  }

  const removeTransaction =
    db.transaction(() => {
      db.prepare(`
        DELETE FROM roster_players
        WHERE id = ?
          AND fantasy_team_id = ?
      `).run(
        playerId,
        teamId
      );

      db.prepare(`
        UPDATE players
        SET
          status = 'available',
          drafted_by = NULL
        WHERE id = ?
      `).run(playerId);

      return player;
    });

  return removeTransaction();
}
function mapDraftPlayer(
  player
) {
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
    catalogSource:
      player.catalogSource,
    sourcePlayerId:
      player.sourcePlayerId,
    catalogActive:
      player.catalogActive === null ||
      player.catalogActive === undefined
        ? null
        : Boolean(
            player.catalogActive
          ),
    catalogStatus:
      player.catalogStatus,

    fantasyProsRank:
      player.fantasyProsRank,

    fantasyProsTier:
      player.fantasyProsTier,

    fantasyProsPositionRank:
      player.fantasyProsPositionRank,

    fantasyProsBye:
      player.fantasyProsBye,

    fantasyProsUpside:
      player.fantasyProsUpside,

    fantasyProsBust:
      player.fantasyProsBust,

    fantasyProsSos:
      player.fantasyProsSos,

    fantasyProsEcrVsAdp:
      player.fantasyProsEcrVsAdp,

    espnInjuryStatus:
      player.espnInjuryStatus,

    espnEstimatedReturn:
      player.espnEstimatedReturn,

    espnInjuryBodyPart:
      player.espnInjuryBodyPart,

    espnInjuryComment:
      player.espnInjuryComment,

    espnInjuryCommentDate:
      player.espnInjuryCommentDate,

    espnSnapshotImportedAt:
      player.espnSnapshotImportedAt,

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
        p.id,
        p.name,
        p.position,
        p.nfl_team AS nflTeam,
        p.bye_week AS byeWeek,
        p.status,
        p.drafted_by AS draftedBy,
        p.rank AS legacyRank,
        p.notes,
        p.catalog_source AS catalogSource,
        p.source_player_id AS sourcePlayerId,
        p.catalog_active AS catalogActive,
        p.catalog_status AS catalogStatus,

        fp.rank AS fantasyProsRank,
        fp.tier AS fantasyProsTier,
        fp.position_rank AS fantasyProsPositionRank,
        fp.bye_week AS fantasyProsBye,
        fp.upside_score AS fantasyProsUpside,
        fp.bust_score AS fantasyProsBust,
        fp.sos_score AS fantasyProsSos,
        fp.ecr_vs_adp AS fantasyProsEcrVsAdp,
        pfn.rank AS pfnRank,

        ei.status AS espnInjuryStatus,
        ei.estimated_return AS espnEstimatedReturn,
        ei.injury_body_part AS espnInjuryBodyPart,
        ei.comment AS espnInjuryComment,
        ei.comment_date AS espnInjuryCommentDate,
        ei.snapshot_imported_at AS espnSnapshotImportedAt

      FROM players p

      LEFT JOIN player_rankings fp
        ON fp.player_id = p.id
        AND fp.source = 'fantasypros'

      LEFT JOIN player_rankings pfn
        ON pfn.player_id = p.id
        AND pfn.source = 'pfn'

      LEFT JOIN espn_injury_snapshot ei
        ON ei.player_id = p.id
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

      return a.name.localeCompare(
        b.name
      );
    });
}

function createDraftPlayer(
  player
) {
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
      catalog_source
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
      'manual'
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

function getDraftPlayerById(
  playerId
) {
  const player = db
    .prepare(`
      SELECT
        p.id,
        p.name,
        p.position,
        p.nfl_team AS nflTeam,
        p.bye_week AS byeWeek,
        p.status,
        p.drafted_by AS draftedBy,
        p.rank AS legacyRank,
        p.notes,
        p.catalog_source AS catalogSource,
        p.source_player_id AS sourcePlayerId,
        p.catalog_active AS catalogActive,
        p.catalog_status AS catalogStatus,

        fp.rank AS fantasyProsRank,
        fp.tier AS fantasyProsTier,
        fp.position_rank AS fantasyProsPositionRank,
        fp.bye_week AS fantasyProsBye,
        fp.upside_score AS fantasyProsUpside,
        fp.bust_score AS fantasyProsBust,
        fp.sos_score AS fantasyProsSos,
        fp.ecr_vs_adp AS fantasyProsEcrVsAdp,
        pfn.rank AS pfnRank,

        ei.status AS espnInjuryStatus,
        ei.estimated_return AS espnEstimatedReturn,
        ei.injury_body_part AS espnInjuryBodyPart,
        ei.comment AS espnInjuryComment,
        ei.comment_date AS espnInjuryCommentDate,
        ei.snapshot_imported_at AS espnSnapshotImportedAt

      FROM players p

      LEFT JOIN player_rankings fp
        ON fp.player_id = p.id
        AND fp.source = 'fantasypros'

      LEFT JOIN player_rankings pfn
        ON pfn.player_id = p.id
        AND pfn.source = 'pfn'

      LEFT JOIN espn_injury_snapshot ei
        ON ei.player_id = p.id

      WHERE p.id = ?
    `)
    .get(playerId);

  if (!player) {
    return null;
  }

  return mapDraftPlayer(player);
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
            nfl_team AS nflTeam
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
            VALUES (
              ?,
              ?,
              ?,
              ?,
              ?
            )
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

      return getDraftPlayerById(
        playerId
      );
    });

  return updateTransaction();
}

function setMetadata(
  key,
  value
) {
  db.prepare(`
    INSERT INTO app_metadata (
      key,
      value
    )
    VALUES (
      ?,
      ?
    )
    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value
  `).run(
    key,
    value
  );
}

function getMetadata(key) {
  const row = db
    .prepare(`
      SELECT value
      FROM app_metadata
      WHERE key = ?
    `)
    .get(key);

  return row
    ? row.value
    : null;
}

function getLastSleeperRefresh() {
  return getMetadata(
    "sleeper_players_last_refresh"
  );
}

function getLastRankingImport(
  source = null
) {
  if (!source) {
    return getMetadata(
      "player_rankings_last_import"
    );
  }

  const rankingSource =
    validateRankingSource(source);

  return getMetadata(
    `${rankingSource}_rankings_last_import`
  );
}

function buildSleeperPlayerName(
  player
) {
  if (
    player.full_name &&
    player.full_name.trim()
  ) {
    return player.full_name.trim();
  }

  const firstName =
    player.first_name
      ? player.first_name.trim()
      : "";

  const lastName =
    player.last_name
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

function chooseFantasyPosition(
  player
) {
  const allowedPositions =
    new Set([
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
    fantasyPositions.find(
      position =>
        allowedPositions.has(
          position
        )
    );

  if (
    matchingFantasyPosition
  ) {
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

function isUsableSleeperPlayer(
  player
) {
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
    chooseFantasyPosition(
      player
    );

  if (!position) {
    return false;
  }

  const name =
    buildSleeperPlayerName(
      player
    );

  if (!name) {
    return false;
  }

  return true;
}

function isRetainableSleeperPlayer(
  player
) {
  return Boolean(
    player &&
    chooseFantasyPosition(player) &&
    buildSleeperPlayerName(player)
  );
}
function importSleeperPlayers(
  sleeperPlayers
) {
  if (
    !sleeperPlayers ||
    typeof sleeperPlayers !==
      "object" ||
    Array.isArray(
      sleeperPlayers
    )
  ) {
    throw new TypeError(
      "Sleeper player data must be an object map."
    );
  }

  const entries =
    Object.entries(
      sleeperPlayers
    );

  const usableEntries =
    entries.filter(
      ([, player]) =>
        isUsableSleeperPlayer(
          player
        )
    );

  const sleeperIds =
    entries.map(
      ([playerId]) =>
        String(playerId)
    );

  const usableIds =
    new Set(
      usableEntries.map(
        ([playerId]) =>
          String(playerId)
      )
    );

  const existingByNameAndPosition =
    buildPlayerLookup(
      db.prepare(`
        SELECT
          id,
          name,
          position,
          nfl_team AS nflTeam,
          catalog_source AS catalogSource
        FROM players
      `).all()
    );

  const findPlayer =
    db.prepare(`
      SELECT
        id,
        status,
        drafted_by AS draftedBy,
        rank,
        notes
      FROM players
      WHERE id = ?
        OR source_player_id = ?
    `);

  const hasRanking =
    db.prepare(`
      SELECT 1
      FROM player_rankings
      WHERE player_id = ?
      LIMIT 1
    `);

  const deletePlayer =
    db.prepare(`
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

  const upsertPlayer =
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
        catalog_source,
        source_player_id,
        catalog_active,
        catalog_status
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
        'sleeper',
        ?,
        ?,
        ?
      )
      ON CONFLICT(id)
      DO UPDATE SET
        name =
          excluded.name,
        position =
          excluded.position,
        nfl_team =
          excluded.nfl_team,
        catalog_source =
          'sleeper',
        source_player_id =
          excluded.source_player_id,
        catalog_active =
          excluded.catalog_active,
        catalog_status =
          excluded.catalog_status
    `);

  const updateSupplementMetadata =
    db.prepare(`
      UPDATE players
      SET
        source_player_id = ?,
        catalog_active = ?,
        catalog_status = ?
      WHERE id = ?
        AND catalog_source =
          'ranking_import_supplement'
    `);

  const importTransaction =
    db.transaction(() => {
      let imported = 0;
      let removed = 0;
      let preserved = 0;

      for (
        const playerId
        of sleeperIds
      ) {
        if (
          usableIds.has(
            playerId
          )
        ) {
          continue;
        }

        const existingPlayer =
          findPlayer.get(
            playerId,
            playerId
          );

        if (!existingPlayer) {
          continue;
        }

        /*
          A missing team or temporary inactive
          status must not evict a valid fantasy
          position from the local catalog.
        */
        if (
          isRetainableSleeperPlayer(
            sleeperPlayers[playerId]
          )
        ) {
          preserved += 1;
          continue;
        }

        /*
          Ranked players are preserved,
          even if Sleeper no longer lists
          them as usable.
        */
        if (
          hasRanking.get(
            playerId
          )
        ) {
          preserved += 1;
          continue;
        }

        const result =
          deletePlayer.run(
            playerId
          );

        if (
          result.changes > 0
        ) {
          removed += 1;
        } else {
          preserved += 1;
        }
      }

      /*
        Enrich ranking supplements with Sleeper
        status data even when the player has no
        current team and remains excluded from the
        broad primary catalog import.
      */
      for (
        const [
          sleeperPlayerId,
          sleeperPlayer
        ] of entries
      ) {
        const position =
          chooseFantasyPosition(
            sleeperPlayer
          );
        const name =
          buildSleeperPlayerName(
            sleeperPlayer
          );

        if (!position || !name) {
          continue;
        }

        const key =
          `${normalizePlayerName(name)}|` +
          `${normalizePosition(position)}`;
        const matches =
          existingByNameAndPosition
            .byNameAndPosition
            .get(key) || [];

        if (matches.length !== 1) {
          continue;
        }

        updateSupplementMetadata.run(
          String(sleeperPlayerId),
          sleeperPlayer.active === false
            ? 0
            : 1,
          sleeperPlayer.status || null,
          matches[0].id
        );
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

        const key =
          `${normalizePlayerName(name)}|` +
          `${normalizePosition(position)}`;
        const matchingPlayers =
          existingByNameAndPosition
            .byNameAndPosition
            .get(key) || [];
        const matchingSupplement =
          matchingPlayers.length === 1 &&
          matchingPlayers[0].catalogSource ===
            'ranking_import_supplement'
            ? matchingPlayers[0]
            : null;

        upsertPlayer.run(
          matchingSupplement?.id ||
            String(playerId),
          name,
          position,
          sleeperPlayer.team,
          String(playerId),
          sleeperPlayer.active === false
            ? 0
            : 1,
          sleeperPlayer.status || null
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

  const totalPlayers =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM players
    `)
      .get()
      .count;

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
    .replace(
      /[^a-z0-9]+/g,
      ""
    );
}

function createNormalizedRow(
  row
) {
  const normalizedRow = {};

  for (
    const [key, value]
    of Object.entries(row)
  ) {
    normalizedRow[
      normalizeHeader(key)
    ] = value;
  }

  return normalizedRow;
}

function getRowValue(
  row,
  aliases
) {
  for (
    const alias
    of aliases
  ) {
    const normalizedAlias =
      normalizeHeader(
        alias
      );

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

function normalizePlayerName(
  value
) {
  const normalizedName =
    String(value || "")
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
    .replace(
      /[^a-z0-9]/g,
      ""
    );

  const safeNameAliases = {
    bamknight: "zonovanknight",
    hollywoodbrown: "marquisebrown",
    nicksingleton:
      "nicholassingleton"
  };

  return (
    safeNameAliases[normalizedName] ||
    normalizedName
  );
}

function normalizePosition(
  value
) {
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
      .replace(
        /[^A-Z]/g,
        ""
      );

  const teamAliases = {
    FA: "FA",
    FREEAGENT: "FA",
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

  return (
    teamAliases[team] ||
    team
  );
}

function parsePositiveInteger(
  value
) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() ===
      ""
  ) {
    return null;
  }

  const number =
    Number.parseInt(
      String(value).trim(),
      10
    );

  if (
    !Number.isInteger(
      number
    ) ||
    number < 1
  ) {
    return null;
  }

  return number;
}

function parseRankedPosition(value) {
  const match = String(value || "")
    .trim()
    .toUpperCase()
    .match(
      /^(QB|RB|WR|TE|K|DEF|DST|D\/ST)(\d+)?$/
    );

  if (!match) {
    return {
      position: normalizePosition(value),
      positionRank: null
    };
  }

  return {
    position: normalizePosition(match[1]),
    positionRank:
      parsePositiveInteger(match[2])
  };
}

function parseFivePointScore(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const match = String(value)
    .trim()
    .match(
      /^([0-5](?:\.\d+)?)\s+out\s+of\s+5(?:\s+stars?)?$/i
    );

  if (!match) {
    return null;
  }

  const score = Number(match[1]);

  return score >= 0 && score <= 5
    ? score
    : null;
}

function parseSignedInteger(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const normalizedValue =
    String(value).trim();

  if (!/^[+-]?\d+$/.test(normalizedValue)) {
    return null;
  }

  return Number.parseInt(
    normalizedValue,
    10
  );
}

function buildPlayerLookup(
  players
) {
  const byName =
    new Map();

  const byNameAndPosition =
    new Map();

  const lookup = {
    byName,
    byNameAndPosition
  };

  for (const player of players) {
    addPlayerToLookup(
      lookup,
      player
    );
  }

  return lookup;
}

function addPlayerToLookup(
  playerLookup,
  player
) {
  const normalizedName =
    normalizePlayerName(
      player.name
    );
  const normalizedPosition =
    normalizePosition(
      player.position
    );

  if (!normalizedName || !normalizedPosition) {
    return;
  }

  const namePositionKey =
    `${normalizedName}|` +
    `${normalizedPosition}`;

  if (!playerLookup.byName.has(normalizedName)) {
    playerLookup.byName.set(
      normalizedName,
      []
    );
  }

  if (
    !playerLookup.byNameAndPosition
      .has(namePositionKey)
  ) {
    playerLookup.byNameAndPosition.set(
      namePositionKey,
      []
    );
  }

  playerLookup.byName
    .get(normalizedName)
    .push(player);
  playerLookup.byNameAndPosition
    .get(namePositionKey)
    .push(player);
}
function chooseRankingMatch(
  normalizedRow,
  playerLookup
) {
  const rawName =
    getRowValue(
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

  const rawPosition =
    getRowValue(
      normalizedRow,
      [
        "position",
        "pos"
      ]
    );

  const rawTeam =
    getRowValue(
      normalizedRow,
      [
        "team",
        "nfl team",
        "nfl_team",
        "tm"
      ]
    );

  const normalizedName =
    normalizePlayerName(
      rawName
    );

  const normalizedPosition =
    parseRankedPosition(
      rawPosition
    ).position;

  const normalizedTeam =
    normalizeTeam(
      rawTeam
    );

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
        .get(key) ||
      [];
  }

  if (
    !normalizedPosition &&
    candidates.length === 0
  ) {
    candidates =
      playerLookup
        .byName
        .get(
          normalizedName
        ) ||
      [];
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
          ) ===
          normalizedTeam
      );

    if (
      teamMatches.length > 0
    ) {
      candidates =
        teamMatches;
    }
  }

  if (
    candidates.length === 1
  ) {
    return {
      status: "matched",
      player:
        candidates[0]
    };
  }

  if (
    candidates.length > 1
  ) {
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

function previewEspnInjurySnapshot(records) {
  if (!Array.isArray(records)) {
    throw new TypeError(
      "ESPN injury records must be an array."
    );
  }

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

  const rows = records.map(record => {
    const match = chooseRankingMatch(
      createNormalizedRow({
        player: record.playerName,
        position: record.position,
        team: record.team
      }),
      playerLookup
    );

    return {
      ...record,
      matchStatus: match.status,
      matchedPlayer:
        match.player
          ? {
              id: match.player.id,
              name: match.player.name,
              position:
                match.player.position,
              nflTeam:
                match.player.nflTeam
            }
          : null
    };
  });

  return {
    rows,
    matched: rows.filter(
      row => row.matchStatus === "matched"
    ).length,
    unmatched: rows.filter(
      row => row.matchStatus === "unmatched"
    ).length,
    ambiguous: rows.filter(
      row => row.matchStatus === "ambiguous"
    ).length
  };
}

function replaceEspnInjurySnapshot(records) {
  const preview =
    previewEspnInjurySnapshot(records);

  const matchedByPlayerId =
    new Map();

  for (const row of preview.rows) {
    if (
      row.matchStatus !== "matched" ||
      !row.matchedPlayer
    ) {
      continue;
    }

    matchedByPlayerId.set(
      row.matchedPlayer.id,
      row
    );
  }

  if (matchedByPlayerId.size === 0) {
    throw new Error(
      "The ESPN snapshot has no matched fantasy players."
    );
  }

  const importedAt =
    new Date().toISOString();

  const insertSnapshot = db.prepare(`
    INSERT INTO espn_injury_snapshot (
      player_id,
      source,
      player_name,
      team,
      position,
      status,
      estimated_return,
      injury_body_part,
      comment,
      comment_date,
      snapshot_imported_at
    )
    VALUES (
      ?,
      'ESPN',
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
  `);

  const replaceTransaction =
    db.transaction(() => {
      db.prepare(`
        DELETE FROM espn_injury_snapshot
      `).run();

      for (
        const row
        of matchedByPlayerId.values()
      ) {
        insertSnapshot.run(
          row.matchedPlayer.id,
          row.playerName,
          row.team,
          row.position,
          row.status,
          row.estimatedReturn,
          row.injuryBodyPart,
          row.comment,
          row.commentDate,
          importedAt
        );
      }
    });

  replaceTransaction();

  return {
    ...preview,
    applied: matchedByPlayerId.size,
    snapshotImportedAt: importedAt
  };
}

function getEspnInjurySnapshotStatus() {
  const status = db
    .prepare(`
      SELECT
        COUNT(*) AS count,
        MAX(snapshot_imported_at)
          AS snapshotImportedAt
      FROM espn_injury_snapshot
    `)
    .get();

  return {
    source: "ESPN",
    count: status.count,
    snapshotImportedAt:
      status.snapshotImportedAt || null
  };
}

function validateRankingSource(
  source
) {
  const normalizedSource =
    String(source || "")
      .trim()
      .toLowerCase();

  const allowedSources =
    new Set([
      "fantasypros",
      "pfn"
    ]);

  if (
    !allowedSources.has(
      normalizedSource
    )
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
  if (
    !Array.isArray(
      rankingRows
    )
  ) {
    throw new TypeError(
      "Ranking data must be an array of CSV rows."
    );
  }

  const rankingSource =
    validateRankingSource(
      source
    );

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
    buildPlayerLookup(
      players
    );

  const insertRankingSupplement =
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
        catalog_source,
        source_player_id,
        catalog_active,
        catalog_status
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
        'ranking_import_supplement',
        NULL,
        NULL,
        ?
      )
    `);

  const upsertRanking =
    db.prepare(`
      INSERT INTO player_rankings (
        player_id,
        source,
        rank,
        tier,
        position_rank,
        bye_week,
        upside_score,
        bust_score,
        sos_score,
        ecr_vs_adp,
        updated_at
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )

      ON CONFLICT(
        player_id,
        source
      )

      DO UPDATE SET
        rank =
          excluded.rank,
        tier =
          excluded.tier,
        position_rank =
          excluded.position_rank,
        bye_week =
          excluded.bye_week,
        upside_score =
          excluded.upside_score,
        bust_score =
          excluded.bust_score,
        sos_score =
          excluded.sos_score,
        ecr_vs_adp =
          excluded.ecr_vs_adp,
        updated_at =
          excluded.updated_at
    `);

  const updateByeWeek =
    db.prepare(`
      UPDATE players
      SET bye_week =
        COALESCE(
          ?,
          bye_week
        )
      WHERE id = ?
    `);

  const importTransaction =
    db.transaction(
      (
        rows,
        importedAt
      ) => {
        let matched = 0;
        let unmatched = 0;
        let ambiguous = 0;
        let invalid = 0;
        let supplemented = 0;

        const unmatchedPlayers =
          [];

        const ambiguousPlayers =
          [];
        const supplementedPlayers =
          [];

        for (
          const originalRow
          of rows
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

          const rawPosition =
            getRowValue(
              row,
              [
                "position",
                "pos"
              ]
            );

          const supplemental =
            rankingSource ===
              "fantasypros"
              ? {
                  tier:
                    parsePositiveInteger(
                      getRowValue(
                        row,
                        ["tier", "tiers"]
                      )
                    ),
                  positionRank:
                    parseRankedPosition(
                      rawPosition
                    ).positionRank,
                  byeWeek:
                    parsePositiveInteger(
                      rawByeWeek
                    ),
                  upside:
                    parseFivePointScore(
                      getRowValue(
                        row,
                        ["upside"]
                      )
                    ),
                  bust:
                    parseFivePointScore(
                      getRowValue(
                        row,
                        ["bust"]
                      )
                    ),
                  sos:
                    parseFivePointScore(
                      getRowValue(
                        row,
                        [
                          "sos season",
                          "sos"
                        ]
                      )
                    ),
                  ecrVsAdp:
                    parseSignedInteger(
                      getRowValue(
                        row,
                        ["ecr vs adp"]
                      )
                    )
                }
              : {
                  tier: null,
                  positionRank: null,
                  byeWeek: null,
                  upside: null,
                  bust: null,
                  sos: null,
                  ecrVsAdp: null
                };

          const rank =
            parsePositiveInteger(
              rawRank
            );

          if (
            !rawName ||
            !rank
          ) {
            invalid += 1;
            continue;
          }

          let match =
            chooseRankingMatch(
              row,
              playerLookup
            );

          if (
            match.status === "unmatched"
          ) {
            const normalizedName =
              normalizePlayerName(
                rawName
              );
            const sourcePosition =
              parseRankedPosition(
                rawPosition
              ).position;
            const allowedPositions =
              new Set([
                "QB",
                "RB",
                "WR",
                "TE",
                "K"
              ]);
            const sameNamePlayers =
              playerLookup.byName.get(
                normalizedName
              ) || [];

            /*
              A ranking row may fill a genuine
              catalog gap, but never resolves a
              position conflict or ambiguity by
              creating a competing identity.
            */
            if (
              normalizedName &&
              allowedPositions.has(
                sourcePosition
              ) &&
              sameNamePlayers.length === 0
            ) {
              const rawTeam =
                getRowValue(
                  row,
                  [
                    "team",
                    "nfl team",
                    "nfl_team",
                    "tm"
                  ]
                );
              const team =
                normalizeTeam(rawTeam) ||
                "FA";
              const supplementId =
                `ranking-supplement:` +
                `${sourcePosition}:` +
                `${normalizedName}`;
              const supplement = {
                id: supplementId,
                name: String(rawName).trim(),
                position: sourcePosition,
                nflTeam: team,
                catalogSource:
                  "ranking_import_supplement"
              };

              insertRankingSupplement.run(
                supplement.id,
                supplement.name,
                supplement.position,
                supplement.nflTeam,
                team === "FA"
                  ? "Free Agent"
                  : "Ranking source"
              );
              addPlayerToLookup(
                playerLookup,
                supplement
              );
              supplemented += 1;
              supplementedPlayers.push(
                supplement.name
              );
              match = {
                status: "matched",
                player: supplement
              };
            }
          }

          if (
            match.status ===
              "matched" &&
            match.player
          ) {
            const byeWeek =
              supplemental.byeWeek ??
              parsePositiveInteger(
                rawByeWeek
              );

            upsertRanking.run(
              match.player.id,
              rankingSource,
              rank,
              supplemental.tier,
              supplemental.positionRank,
              supplemental.byeWeek,
              supplemental.upside,
              supplemental.bust,
              supplemental.sos,
              supplemental.ecrVsAdp,
              importedAt
            );

            updateByeWeek.run(
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
              ambiguousPlayers
                .length < 20
            ) {
              ambiguousPlayers
                .push(
                  String(
                    rawName
                  ).trim()
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
              unmatchedPlayers
                .length < 20
            ) {
              unmatchedPlayers
                .push(
                  String(
                    rawName
                  ).trim()
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
          supplemented,
          unmatchedPlayers,
          ambiguousPlayers,
          supplementedPlayers
        };
      }
    );

  const importedAt =
    new Date().toISOString();

  const result =
    importTransaction(
      rankingRows,
      importedAt
    );

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
      SELECT
        COUNT(*) AS count
      FROM player_rankings
      WHERE source = ?
    `)
      .get(
        rankingSource
      )
      .count;

  return {
    ...result,
    source:
      rankingSource,
    rowsReceived:
      rankingRows.length,
    rankedPlayers,
    importedAt
  };
}
function getRankingStatus() {
  const counts =
    db.prepare(`
      SELECT
        source,
        COUNT(*) AS count
      FROM player_rankings
      WHERE source IN (
        'fantasypros',
        'pfn'
      )
      GROUP BY source
    `)
      .all();

  const countBySource =
    new Map(
      counts.map(
        row => [
          row.source,
          row.count
        ]
      )
    );

  return {
    fantasyPros: {
      lastImport:
        getLastRankingImport(
          "fantasypros"
        ),

      rankedPlayers:
        countBySource.get(
          "fantasypros"
        ) || 0
    },

    pfn: {
      lastImport:
        getLastRankingImport(
          "pfn"
        ),

      rankedPlayers:
        countBySource.get(
          "pfn"
        ) || 0
    }
  };
}

function clearRankingSource(
  source
) {
  const rankingSource =
    validateRankingSource(
      source
    );

  const result =
    db.prepare(`
      DELETE FROM player_rankings
      WHERE source = ?
    `)
      .run(
        rankingSource
      );

  db.prepare(`
    DELETE FROM app_metadata
    WHERE key = ?
  `).run(
    `${rankingSource}_rankings_last_import`
  );

  return {
    source:
      rankingSource,

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
  clearRankingSource,
  calculateCombinedRank,
  createNormalizedRow,
  parseRankedPosition,
  parseFivePointScore,
  parseSignedInteger,
  previewEspnInjurySnapshot,
  replaceEspnInjurySnapshot,
  getEspnInjurySnapshotStatus
};
