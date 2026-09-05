const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDatabasePath = path.join(
  os.tmpdir(),
  "benchwarmers-catalog-repair-" +
    process.pid +
    ".db"
);

process.env.BENCHWARMERS_DB_FILE =
  testDatabasePath;

const {
  db,
  createDraftPlayer,
  getDraftPlayers,
  importPlayerRankings,
  importSleeperPlayers,
  replaceEspnInjurySnapshot,
  calculateCombinedRank
} = require("../database");

try {
  createDraftPlayer({
    id: "canonical-player",
    name: "Canonical Player",
    position: "RB",
    nflTeam: "DET"
  });
  createDraftPlayer({
    id: "position-conflict",
    name: "Position Conflict",
    position: "TE",
    nflTeam: "MIN"
  });

  const fantasyProsResult =
    importPlayerRankings(
      [
        {
          RK: "1",
          "PLAYER NAME": "Tyreek Hill",
          TEAM: "FA",
          POS: "WR1",
          TIERS: "1",
          UPSIDE: "5 out of 5"
        },
        {
          RK: "2",
          "PLAYER NAME": "Canonical Player",
          TEAM: "CHI",
          POS: "RB2"
        },
        {
          RK: "3",
          "PLAYER NAME": "Position Conflict",
          TEAM: "MIN",
          POS: "RB3"
        },
        {
          RK: "4",
          "PLAYER NAME": "Imaginary Defense",
          TEAM: "FA",
          POS: "DEF1"
        }
      ],
      "fantasypros"
    );

  assert.deepEqual(
    {
      matched: fantasyProsResult.matched,
      unmatched: fantasyProsResult.unmatched,
      supplemented:
        fantasyProsResult.supplemented
    },
    {
      matched: 2,
      unmatched: 2,
      supplemented: 1
    }
  );

  let tyreek = getDraftPlayers().find(
    player => player.name === "Tyreek Hill"
  );
  assert.ok(tyreek);
  assert.equal(tyreek.position, "WR");
  assert.equal(tyreek.nflTeam, "FA");
  assert.equal(
    tyreek.catalogSource,
    "ranking_import_supplement"
  );
  assert.equal(tyreek.fantasyProsRank, 1);
  assert.equal(tyreek.fantasyProsTier, 1);
  assert.equal(tyreek.fantasyProsUpside, 5);

  const canonical = getDraftPlayers().find(
    player =>
      player.name === "Canonical Player"
  );
  assert.equal(canonical.id, "canonical-player");
  assert.equal(canonical.nflTeam, "DET");
  assert.equal(canonical.position, "RB");
  assert.equal(canonical.catalogSource, "manual");

  assert.equal(
    getDraftPlayers().filter(
      player =>
        player.name === "Position Conflict"
    ).length,
    1
  );
  assert.equal(
    getDraftPlayers().some(
      player =>
        player.name === "Imaginary Defense"
    ),
    false
  );

  const pfnResult = importPlayerRankings(
    [
      {
        Rank: "2",
        Player: "Tyreek Hill",
        Team: "MIA",
        Position: "WR"
      },
      {
        Rank: "3",
        Player: "Free Agent Veteran",
        Team: "FA",
        Position: "RB"
      }
    ],
    "pfn"
  );

  assert.equal(pfnResult.matched, 2);
  assert.equal(pfnResult.supplemented, 1);
  assert.equal(
    getDraftPlayers().filter(
      player => player.name === "Tyreek Hill"
    ).length,
    1
  );

  tyreek = getDraftPlayers().find(
    player => player.name === "Tyreek Hill"
  );
  assert.equal(tyreek.pfnRank, 2);
  assert.equal(
    tyreek.combinedRank,
    calculateCombinedRank(1, 2)
  );

  replaceEspnInjurySnapshot(
    [
      {
        playerName: "Tyreek Hill",
        team: "MIA",
        position: "WR",
        status: "Questionable",
        estimatedReturn: "Week 1",
        injuryBodyPart: "knee",
        comment: "Limited in practice.",
        commentDate: "Aug 29"
      }
    ],
    "2026-08-30T12:00:00.000Z"
  );

  tyreek = getDraftPlayers().find(
    player => player.name === "Tyreek Hill"
  );
  assert.equal(
    tyreek.espnInjuryStatus,
    "Questionable"
  );

  const localTyreekId = tyreek.id;
  importSleeperPlayers({
    "sleeper-tyreek": {
      full_name: "Tyreek Hill",
      position: "WR",
      fantasy_positions: ["WR"],
      team: "MIA",
      active: true,
      status: "Active"
    },
    "sleeper-free-agent": {
      full_name: "Free Agent Veteran",
      position: "RB",
      fantasy_positions: ["RB"],
      team: null,
      active: false,
      status: "Inactive"
    }
  });

  const tyreekPlayers = getDraftPlayers().filter(
    player => player.name === "Tyreek Hill"
  );
  assert.equal(tyreekPlayers.length, 1);
  assert.equal(tyreekPlayers[0].id, localTyreekId);
  assert.equal(tyreekPlayers[0].nflTeam, "MIA");
  assert.equal(
    tyreekPlayers[0].catalogSource,
    "sleeper"
  );
  assert.equal(
    tyreekPlayers[0].sourcePlayerId,
    "sleeper-tyreek"
  );
  assert.equal(tyreekPlayers[0].catalogActive, true);
  assert.equal(tyreekPlayers[0].catalogStatus, "Active");
  assert.equal(tyreekPlayers[0].fantasyProsRank, 1);
  assert.equal(tyreekPlayers[0].pfnRank, 2);

  const freeAgent = getDraftPlayers().find(
    player =>
      player.name === "Free Agent Veteran"
  );
  assert.ok(freeAgent);
  assert.equal(freeAgent.nflTeam, "FA");
  assert.equal(
    freeAgent.catalogSource,
    "ranking_import_supplement"
  );
  assert.equal(
    freeAgent.sourcePlayerId,
    "sleeper-free-agent"
  );
  assert.equal(freeAgent.catalogActive, false);
  assert.equal(freeAgent.catalogStatus, "Inactive");
  assert.equal(freeAgent.pfnRank, 3);

  console.log(
    "Catalog supplement, dedupe, provenance, " +
      "ranking, Sleeper, and ESPN join tests passed."
  );
} finally {
  db.close();

  for (const suffix of ["", "-shm", "-wal"]) {
    const filePath = testDatabasePath + suffix;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
