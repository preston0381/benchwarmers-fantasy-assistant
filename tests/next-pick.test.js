const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const RosterNeeds = require(
  "../public/roster-needs"
);

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8"
);
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

assert.ok(scriptMatch, "The app's inline script should exist.");

const element = new Proxy(
  {
    addEventListener() {},
    append() {},
    appendChild() {},
    classList: { add() {}, remove() {} },
    focus() {},
    removeChild() {},
    setAttribute() {},
    value: "",
    hidden: false,
    innerHTML: "",
    textContent: ""
  },
  {
    get(target, property) {
      return property in target ? target[property] : "";
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }
);

const context = vm.createContext({
  console: { error() {}, log() {}, warn() {} },
  document: {
    addEventListener() {},
    body: element,
    createElement() {
      return Object.create(element);
    },
    getElementById() {
      return element;
    }
  },
  fetch: async () => {
    throw new Error("Network disabled in selector tests.");
  },
  FormData: class FormData {
    append() {}
  },
  setTimeout,
  window: {
    BenchwarmersRosterNeeds: RosterNeeds,
    confirm() {
      return false;
    }
  }
});

vm.runInContext(scriptMatch[1], context);

const {
  buildNextPickContext,
  calculateDartScore,
  calculateNextPickRosterNeed,
  calculateNextPickScore,
  calculateUpsideScore,
  calculateFantasyProsTierSignal,
  calculateMarketUrgency,
  createDraftStateSignature,
  createInjuryBadge,
  estimatePlayerSurvival,
  evaluateEspnInjuryRisk,
  formatInjuryDate,
  getDraftStageContext,
  getDraftSyncConflict,
  getInjuryBadgeStatus,
  getInjuryTooltipLines,
  getSuggestedPicks,
  pollDraftState,
  selectBestAlternative
} = context;

function makePlayer(
  id,
  name,
  position,
  recommendationScore,
  rank,
  extras = {}
) {
  return {
    id,
    name,
    position,
    nflTeam: "TST",
    status: "available",
    recommendationScore,
    recommendationLabel:
      recommendationScore >= 95
        ? "Elite pick"
        : recommendationScore >= 88
          ? "Strong value"
          : recommendationScore >= 78
            ? "Good pick"
            : "Reach territory",
    combinedRank: rank,
    rank,
    scarcityValue: 2,
    scarcityLabel: "Low",
    nextPositionRank: rank + 4,
    nearbyAlternatives: 5,
    sleeperSignal: "Low",
    rankingGap: 1,
    ...extras
  };
}

const eliteRB = makePlayer(
  "rb1",
  "Elite RB",
  "RB",
  96,
  1,
  {
    scarcityValue: 5,
    nextPositionRank: 8
  }
);
const closeWR = makePlayer(
  "wr1",
  "Close WR",
  "WR",
  94,
  3
);
const topQB = makePlayer(
  "qb1",
  "Top QB",
  "QB",
  92,
  18,
  {
    scarcityValue: 7,
    scarcityLabel: "High",
    nextPositionRank: 38,
    nearbyAlternatives: 1
  }
);
const waitTE = makePlayer(
  "te1",
  "Wait TE",
  "TE",
  88,
  28,
  {
    scarcityValue: 3,
    nextPositionRank: 31
  }
);
const deepSleeper = makePlayer(
  "sl1",
  "Deep Sleeper",
  "WR",
  82,
  80,
  {
    sleeperSignal: "High",
    rankingGap: 30
  }
);
const basePlayers = [
  eliteRB,
  closeWR,
  topQB,
  waitTE,
  deepSleeper
];
const alerts = [
  {
    position: "RB",
    scarcityValue: 5,
    alertLevel: "Medium",
    draftedTopEndCount: 0
  },
  {
    position: "WR",
    scarcityValue: 2,
    alertLevel: "Low",
    draftedTopEndCount: 0
  },
  {
    position: "QB",
    scarcityValue: 7,
    alertLevel: "High",
    draftedTopEndCount: 0
  },
  {
    position: "TE",
    scarcityValue: 3,
    alertLevel: "Medium",
    draftedTopEndCount: 0
  }
];

function makeContext(overrides = {}) {
  return buildNextPickContext({
    players: basePlayers,
    roster: [],
    alerts,
    passingTouchdownPoints: 6,
    ...overrides
  });
}

function rosterFromCounts(counts) {
  return Object.entries(counts).flatMap(
    ([position, count]) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${position}-${index + 1}`,
        name: `${position} ${index + 1}`,
        position
      }))
  );
}

const rosterA = rosterFromCounts({
  RB: 2,
  WR: 2,
  TE: 1
});
const analysisA =
  RosterNeeds.analyzeRosterNeeds(rosterA);
assert.equal(
  analysisA.flexOpen,
  true,
  "FLEX A: RB2/WR2/TE1 should leave FLEX open."
);
assert.equal(
  RosterNeeds.getPositionNeed(
    analysisA,
    "RB"
  ).needWeight,
  0.6,
  "FLEX A: an eligible FLEX candidate should receive the shared 60% need weight."
);

const rosterB = rosterFromCounts({
  RB: 3,
  WR: 2,
  TE: 1
});
assert.equal(
  RosterNeeds.analyzeRosterNeeds(rosterB).flexFilled,
  true,
  "FLEX B: RB3/WR2/TE1 should fill FLEX."
);

const rosterC = rosterFromCounts({
  RB: 2,
  WR: 3,
  TE: 1
});
assert.equal(
  RosterNeeds.analyzeRosterNeeds(rosterC).flexFilled,
  true,
  "FLEX C: RB2/WR3/TE1 should fill FLEX."
);

const rosterD = rosterFromCounts({
  RB: 2,
  WR: 2,
  TE: 2
});
assert.equal(
  RosterNeeds.analyzeRosterNeeds(rosterD).flexFilled,
  true,
  "FLEX D: RB2/WR2/TE2 should fill FLEX."
);

const rosterE = rosterFromCounts({
  RB: 3,
  WR: 1,
  TE: 1
});
const analysisE =
  RosterNeeds.analyzeRosterNeeds(rosterE);
assert.equal(
  RosterNeeds.getPositionNeed(analysisE, "WR").needType,
  "fixed",
  "FLEX E: WR2 must remain a fixed starter need."
);
assert.equal(
  RosterNeeds.getPositionNeed(analysisE, "WR").needWeight,
  0.5,
  "FLEX E: one missing slot from a two-WR target should retain a 50% fixed-need weight."
);
assert.equal(
  RosterNeeds.getPositionNeed(analysisE, "RB").needType,
  "bench",
  "FLEX E: another RB must not mask the missing WR starter."
);

const flexCandidates = [
  makePlayer("flex-rb", "Elite RB3", "RB", 93, 10),
  makePlayer("flex-wr", "Elite WR3", "WR", 93, 10)
];
const flexContext = makeContext({
  players: flexCandidates,
  roster: rosterA
});
const rbFlexNeed = calculateNextPickRosterNeed(
  flexCandidates[0],
  flexContext
);
const wrFlexNeed = calculateNextPickRosterNeed(
  flexCandidates[1],
  flexContext
);
assert.deepEqual(
  [rbFlexNeed.needType, wrFlexNeed.needType],
  ["flex", "flex"],
  "FLEX F: RB3 and WR3 should both receive FLEX consideration."
);
assert.equal(
  rbFlexNeed.points,
  wrFlexNeed.points,
  "FLEX F: similarly valued RB3 and WR3 should receive equal FLEX need points."
);

const filledFlexContext = makeContext({
  players: [
    makePlayer("bench-rb", "Bench RB", "RB", 90, 20),
    makePlayer("bench-wr", "Bench WR", "WR", 90, 20),
    makePlayer("bench-te", "Bench TE", "TE", 90, 20)
  ],
  roster: rosterB
});
const filledFlexNeeds =
  filledFlexContext.availablePlayers.map(player =>
    calculateNextPickRosterNeed(
      player,
      filledFlexContext
    )
  );
assert.ok(
  filledFlexNeeds.every(need =>
    need.needType === "bench" &&
    need.points < rbFlexNeed.points
  ),
  "FLEX G: additional RB/WR/TE should fall back to bench-depth need."
);
assert.equal(
  RosterNeeds.getPositionNeed(
    RosterNeeds.analyzeRosterNeeds(rosterB),
    "RB"
  ).needWeight,
  0,
  "FLEX G: the shared starter-need weight should be zero after FLEX is filled."
);

const nonFlexRoster = [
  ...rosterA,
  ...rosterFromCounts({ QB: 2, K: 2, DEF: 2 })
];
const nonFlexAnalysis =
  RosterNeeds.analyzeRosterNeeds(nonFlexRoster);
assert.equal(
  nonFlexAnalysis.flexOpen,
  true,
  "FLEX H: extra QB/K/DEF players must not fill FLEX."
);
assert.ok(
  ["QB", "K", "DEF"].every(position =>
    RosterNeeds.getPositionNeed(
      nonFlexAnalysis,
      position
    ).needType !== "flex"
  ),
  "FLEX H: QB/K/DEF must never be classified as FLEX needs."
);

console.log("FLEX roster scenarios A-H passed.");

const emptyRosterResult = getSuggestedPicks(makeContext());
assert.equal(
  emptyRosterResult.best.player.id,
  "rb1",
  "Test 1: an elite player should lead an empty-roster board."
);

const draftedPlayers = basePlayers.map(player =>
  player.id === "rb1"
    ? { ...player, status: "drafted", draftedBy: "other" }
    : player
);
const draftedResult = getSuggestedPicks(
  makeContext({ players: draftedPlayers })
);
assert.ok(
  !draftedResult.scoredPlayers.some(
    candidate => candidate.player.id === "rb1"
  ),
  "Test 2: a player drafted by Other must be ineligible."
);

const twoRunningBacks = [
  { id: "roster-rb-1", position: "RB" },
  { id: "roster-rb-2", position: "RB" }
];
const filledRbResult = getSuggestedPicks(
  makeContext({
    players: [eliteRB, closeWR],
    roster: twoRunningBacks
  })
);
assert.equal(
  filledRbResult.best.player.position,
  "WR",
  "Test 3: two rostered RBs should let close value at another need win."
);

const depletedAlerts = alerts.map(alert =>
  alert.position === "RB"
    ? {
        ...alert,
        draftedTopEndCount: 6,
        scarcityValue: 10,
        alertLevel: "Critical"
      }
    : alert
);
const depletedRB = {
  ...eliteRB,
  scarcityValue: 10,
  scarcityLabel: "Critical",
  nearbyAlternatives: 1,
  nextPositionRank: 16
};
const normalScore = calculateNextPickScore(
  eliteRB,
  makeContext()
).nextPickScore;
const depletedContext = makeContext({
  players: [depletedRB, closeWR],
  alerts: depletedAlerts
});
const depletedScore = calculateNextPickScore(
  depletedRB,
  depletedContext
).nextPickScore;
assert.ok(
  depletedScore > normalScore,
  "Test 4: top-end RB depletion should increase RB urgency."
);

const comparableWR = makePlayer(
  "wr2",
  "Comparable WR",
  "WR",
  92,
  15,
  {
    scarcityValue: 1,
    nearbyAlternatives: 7,
    nextPositionRank: 18
  }
);
const qbResult = getSuggestedPicks(
  makeContext({
    players: [topQB, comparableWR, waitTE]
  })
);
assert.equal(
  qbResult.best.player.position,
  "QB",
  "Test 5: a scarce top QB may beat a comparable WR pool."
);
assert.ok(
  qbResult.best.components.quarterbackScoring > 0,
  "Test 5: six-point passing TD scoring should contribute to that choice."
);

const sleeperResult = getSuggestedPicks(
  makeContext({ players: [eliteRB, deepSleeper] })
);
assert.equal(
  sleeperResult.best.player.id,
  "rb1",
  "Test 6: sleeper disagreement must not overpower elite talent."
);

const restoredPlayers = draftedPlayers.map(player =>
  player.id === "rb1"
    ? { ...player, status: "available", draftedBy: null }
    : player
);
const restoredResult = getSuggestedPicks(
  makeContext({ players: restoredPlayers })
);
assert.ok(
  restoredResult.scoredPlayers.some(
    candidate => candidate.player.id === "rb1"
  ),
  "Test 7: making a player available should restore eligibility."
);

const distinctIds = [
  emptyRosterResult.best?.player.id,
  emptyRosterResult.alternative?.player.id,
  emptyRosterResult.waitOption?.player.id
];
assert.equal(
  new Set(distinctIds).size,
  distinctIds.length,
  "Test 8: best, alternative, and wait choices should be distinct."
);

const controlledBest = {
  player: eliteRB,
  nextPickScore: 90,
  rank: 1
};
const controlledPeer = {
  player: {
    ...eliteRB,
    id: "rb2",
    name: "Elite RB Peer"
  },
  nextPickScore: 88,
  rank: 2
};
const controlledQB = {
  player: {
    ...topQB,
    id: "qb2",
    name: "Lower QB"
  },
  nextPickScore: 84,
  rank: 18
};
const guardedAlternative = selectBestAlternative(
  [controlledBest, controlledPeer, controlledQB],
  controlledBest
);
assert.equal(
  guardedAlternative.player.id,
  "rb2",
  "Alternative guardrail: elite same-position value must stay ahead of a materially lower-ranked QB."
);

console.log(
  "Next Suggested Pick scenarios 1-8 and alternative guardrails passed."
);

function addDraftedPlayers(availablePlayers, totalDrafted) {
  return [
    ...availablePlayers,
    ...Array.from({ length: totalDrafted }, (_, index) => ({
      id: `drafted-${index + 1}`,
      name: `Drafted Player ${index + 1}`,
      position: "WR",
      status: "drafted",
      combinedRank: 300 + index,
      rank: 300 + index,
      recommendationScore: 0,
      scarcityValue: 0,
      sleeperSignal: "Low"
    }))
  ];
}

function makeStageContext(
  availablePlayers,
  totalDrafted,
  roster = [],
  stageAlerts = []
) {
  return buildNextPickContext({
    players:
      addDraftedPlayers(availablePlayers, totalDrafted),
    roster,
    alerts: stageAlerts,
    passingTouchdownPoints: 6
  });
}

const fullStarters = rosterFromCounts({
  QB: 1,
  RB: 3,
  WR: 2,
  TE: 1,
  K: 1,
  DEF: 1
});
const offenseStarters = rosterFromCounts({
  QB: 1,
  RB: 3,
  WR: 2,
  TE: 1
});
const strongDartContext = {
  rolePath: 7,
  contingentUpside: 10,
  roleGrowth: 6,
  recentPositiveContext: 6,
  ceiling: 9,
  floor: 3
};
const lowCeilingContext = {
  rolePath: 5,
  contingentUpside: 1,
  roleGrowth: 1,
  recentPositiveContext: 1,
  ceiling: 3,
  floor: 8
};

assert.deepEqual(
  [
    getDraftStageContext(59).stage,
    getDraftStageContext(60).stage,
    getDraftStageContext(119).stage,
    getDraftStageContext(120).stage
  ],
  ["early", "middle", "middle", "late"],
  "Draft stages should follow picks 1-60, 61-120, and 121-180."
);

const earlyElite = makePlayer(
  "early-elite",
  "Early Elite",
  "RB",
  96,
  1
);
const earlyDart = makePlayer(
  "early-dart",
  "Early Dart",
  "RB",
  81,
  30,
  { upsideContext: strongDartContext, sleeperSignal: "High" }
);
const earlyResult = getSuggestedPicks(
  makeStageContext([earlyElite, earlyDart], 0, [])
);
assert.equal(
  earlyResult.best.player.id,
  "early-elite",
  "Late A: elite talent must dominate an empty round-one roster."
);
assert.equal(
  earlyResult.scoredPlayers.find(
    candidate => candidate.player.id === "early-dart"
  ).components.dart,
  0,
  "Late A: dart scoring should have no round-one influence."
);

const roundFiveResult = getSuggestedPicks(
  makeStageContext([eliteRB, closeWR, earlyDart], 59, [])
);
assert.equal(
  roundFiveResult.best.player.id,
  "rb1",
  "Late B: round-five value/need behavior should remain intact."
);

const middleSafe = makePlayer(
  "middle-safe",
  "Middle Safe",
  "WR",
  91,
  90,
  { upsideContext: lowCeilingContext }
);
const middleUpside = makePlayer(
  "middle-upside",
  "Middle Upside",
  "WR",
  85,
  105,
  { upsideContext: strongDartContext }
);
const middleResult = getSuggestedPicks(
  makeStageContext(
    [middleSafe, middleUpside],
    84,
    offenseStarters
  )
);
const middleUpsideCandidate =
  middleResult.scoredPlayers.find(
    candidate => candidate.player.id === "middle-upside"
  );
assert.ok(
  middleUpsideCandidate.components.upside > 0 &&
  middleUpsideCandidate.components.upside < 3,
  "Late C: upside should begin contributing modestly in round eight."
);
assert.equal(
  middleResult.best.player.id,
  "middle-safe",
  "Late C: middle-round upside must not dominate clear value."
);

const lateVeteran = makePlayer(
  "late-veteran",
  "Low-Ceiling Veteran",
  "RB",
  84,
  132,
  { upsideContext: lowCeilingContext }
);
const lateBackup = makePlayer(
  "late-backup",
  "Contingent RB",
  "RB",
  84,
  142,
  { upsideContext: strongDartContext }
);
const lateResult = getSuggestedPicks(
  makeStageContext(
    [lateVeteran, lateBackup],
    132,
    fullStarters
  )
);
assert.equal(
  lateResult.best.player.id,
  "late-backup",
  "Late D: a strong contingent RB may beat a slightly higher-ranked low-ceiling veteran in round 12."
);

const clearSuperior = makePlayer(
  "clear-superior",
  "Clear Superior",
  "WR",
  90,
  120,
  { upsideContext: lowCeilingContext }
);
const distantDart = makePlayer(
  "distant-dart",
  "Distant Dart",
  "RB",
  84,
  175,
  { upsideContext: strongDartContext }
);
const guardrailResult = getSuggestedPicks(
  makeStageContext(
    [clearSuperior, distantDart],
    132,
    fullStarters
  )
);
const distantCandidate =
  guardrailResult.scoredPlayers.find(
    candidate => candidate.player.id === "distant-dart"
  );
assert.equal(
  guardrailResult.best.player.id,
  "clear-superior",
  "Late E: a speculative player must not jump talent 50-plus ranks ahead."
);
assert.equal(
  distantCandidate.speculativeRankEligible,
  false,
  "Late E: the speculative rank-jump guardrail should disable the late bonus."
);

const lateQB = makePlayer(
  "late-qb",
  "Late QB2",
  "QB",
  88,
  125
);
const qb2Context = makeStageContext(
  [lateQB],
  132,
  fullStarters
);
const qb2Candidate = calculateNextPickScore(
  lateQB,
  qb2Context
);
assert.ok(
  qb2Candidate.qbDepthSuppression >= 7,
  "Late F: an already-rostered starting QB should strongly suppress QB2 in round 12."
);

const noQBRoster = fullStarters.filter(
  player => player.position !== "QB"
);
const qbNeedContext = makeStageContext(
  [lateQB],
  132,
  noQBRoster
);
const qbNeedCandidate = calculateNextPickScore(
  lateQB,
  qbNeedContext
);
assert.equal(
  qbNeedCandidate.qbDepthSuppression,
  0,
  "Late G: an unfilled QB slot must not receive QB2 suppression."
);
assert.equal(
  qbNeedCandidate.rosterNeed.needType,
  "fixed",
  "Late G: QB should remain a fixed starter need late."
);

const fragileDart = calculateDartScore(
  lateBackup,
  makeStageContext([lateBackup], 132, []),
  calculateUpsideScore(lateBackup)
);
const constructedDart = calculateDartScore(
  lateBackup,
  makeStageContext(
    [lateBackup],
    132,
    fullStarters
  ),
  calculateUpsideScore(lateBackup)
);
assert.ok(
  constructedDart.score > fragileDart.score,
  "Late H: completed starters should increase the appeal of bench upside."
);

const lateKicker = makePlayer(
  "late-k",
  "Late Kicker",
  "K",
  88,
  140
);
const strongSkill = makePlayer(
  "late-skill",
  "Useful Upside RB",
  "RB",
  86,
  145,
  { upsideContext: strongDartContext }
);
const skillVsKickerResult = getSuggestedPicks(
  makeStageContext(
    [lateKicker, strongSkill],
    132,
    offenseStarters
  )
);
assert.equal(
  skillVsKickerResult.best.player.id,
  "late-skill",
  "Late I: useful skill-position upside should keep K/DEF from being forced."
);

const weakSkill = makePlayer(
  "weak-skill",
  "Weak Bench Option",
  "WR",
  80,
  145,
  { upsideContext: lowCeilingContext }
);
const endKicker = makePlayer(
  "end-k",
  "Endgame Kicker",
  "K",
  85,
  150
);
const endgameResult = getSuggestedPicks(
  makeStageContext(
    [endKicker, weakSkill],
    168,
    offenseStarters
  )
);
assert.equal(
  endgameResult.best.player.id,
  "end-k",
  "Late J: K/DEF may become appropriate near the end when skill upside is weak."
);

const ownedTeamRoster = [
  ...fullStarters,
  {
    id: "owned-rb",
    name: "Owned Starter",
    position: "RB",
    nflTeam: "AAA"
  }
];
const sameTeamBackup = makePlayer(
  "same-team",
  "Same-Team Backup",
  "RB",
  84,
  140,
  {
    nflTeam: "AAA",
    upsideContext: strongDartContext
  }
);
const otherTeamBackup = makePlayer(
  "other-team",
  "Other-Team Backup",
  "RB",
  84,
  140,
  {
    nflTeam: "BBB",
    upsideContext: strongDartContext
  }
);
const handcuffContext = makeStageContext(
  [sameTeamBackup, otherTeamBackup],
  132,
  ownedTeamRoster
);
assert.equal(
  calculateNextPickScore(
    sameTeamBackup,
    handcuffContext
  ).nextPickScore,
  calculateNextPickScore(
    otherTeamBackup,
    handcuffContext
  ).nextPickScore,
  "Late K: same-team handcuffs must receive no automatic large bonus."
);

const lateDistinctResult = getSuggestedPicks(
  makeStageContext(
    [
      lateVeteran,
      lateBackup,
      clearSuperior,
      weakSkill
    ],
    132,
    fullStarters
  )
);
const lateDistinctIds = [
  lateDistinctResult.best?.player.id,
  lateDistinctResult.alternative?.player.id,
  lateDistinctResult.waitOption?.player.id
];
assert.equal(
  new Set(lateDistinctIds).size,
  lateDistinctIds.length,
  "Late L: Best, Alternative, and Value/Wait should remain distinct."
);

console.log("Late-draft scenarios A-M passed.");

module.exports = {
  buildNextPickContext,
  calculateDartScore,
  calculateNextPickRosterNeed,
  calculateNextPickScore,
  calculateUpsideScore,
  calculateFantasyProsTierSignal,
  calculateMarketUrgency,
  createDraftStateSignature,
  createInjuryBadge,
  estimatePlayerSurvival,
  evaluateEspnInjuryRisk,
  formatInjuryDate,
  getDraftStageContext,
  getDraftSyncConflict,
  getInjuryBadgeStatus,
  getInjuryTooltipLines,
  getSuggestedPicks,
  pollDraftState,
  selectBestAlternative
};
