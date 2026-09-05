const assert = require("node:assert/strict");

const {
  buildNextPickContext,
  calculateNextPickScore,
  evaluateEspnInjuryRisk,
  getSuggestedPicks
} = require("./next-pick.test");

function player(
  id,
  name,
  position,
  rank,
  recommendationScore,
  extras = {}
) {
  return {
    id,
    name,
    position,
    nflTeam: "TST",
    status: "available",
    combinedRank: rank,
    rank,
    recommendationScore,
    recommendationLabel:
      recommendationScore >= 95
        ? "Elite pick"
        : recommendationScore >= 88
          ? "Strong value"
          : recommendationScore >= 78
            ? "Good pick"
            : recommendationScore >= 65
              ? "Reach territory"
              : "Probably wait",
    scarcityValue: 2,
    scarcityLabel: "Low",
    nextPositionRank: rank + 5,
    nearbyAlternatives: 4,
    sleeperSignal: "Low",
    rankingGap: 2,
    ...extras
  };
}

function roster(counts) {
  const result = [];

  for (const [position, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      result.push({
        id: `roster-${position}-${index}`,
        name: `Roster ${position} ${index + 1}`,
        position,
        nflTeam: "ROS"
      });
    }
  }

  return result;
}

function contextAtPick(
  availablePlayers,
  currentPick,
  currentRoster = [],
  alerts = []
) {
  const draftedPlayers = Array.from(
    { length: Math.max(0, currentPick - 1) },
    (_, index) => ({
      id: `drafted-${currentPick}-${index}`,
      name: `Drafted ${index + 1}`,
      position: "WR",
      status: "drafted",
      combinedRank: index + 1,
      rank: index + 1
    })
  );

  return buildNextPickContext({
    players: [
      ...availablePlayers,
      ...draftedPlayers
    ],
    roster: currentRoster,
    alerts,
    passingTouchdownPoints: 6,
    nextOpportunityWindow: 12
  });
}

function topFive(result) {
  return result.scoredPlayers
    .slice(0, 5)
    .map(candidate => ({
      player: candidate.player.name,
      position: candidate.player.position,
      combinedRank: candidate.rank,
      recommendationScore:
        candidate.player.recommendationScore,
      nextPickScore: candidate.nextPickScore,
      modifiers: Object.fromEntries(
        Object.entries(candidate.components)
          .filter(([, value]) => Math.abs(value) >= 0.01)
          .map(([key, value]) => [
            key,
            Number(value.toFixed(2))
          ])
      )
    }));
}

const reports = [];

function runScenario({
  number,
  name,
  currentPick,
  currentRoster = [],
  availablePlayers,
  alerts = [],
  check
}) {
  const context = contextAtPick(
    availablePlayers,
    currentPick,
    currentRoster,
    alerts
  );
  const result = getSuggestedPicks(context);
  const outcome = check(result, context);
  const passed = outcome === true;

  reports.push({
    scenario: number,
    name,
    stage: context.draftStage.stage,
    roster: context.rosterNeeds.positionCounts,
    keyAvailable: availablePlayers.map(
      candidate => `${candidate.name} (${candidate.position})`
    ),
    topFive: topFive(result),
    best: result.best.player.name,
    alternative: result.alternative?.player.name || null,
    valueWait: result.waitOption
      ? `${result.waitOption.player.name}: ${result.waitOption.survival.label}`
      : null,
    status: passed ? "PASS" : "REVIEW",
    note: passed ? "Expected hierarchy preserved." : outcome
  });

  if (!passed) {
    console.error(
      JSON.stringify(reports.at(-1), null, 2)
    );
  }

  assert.equal(
    passed,
    true,
    `Stress scenario ${number} requires review: ${outcome}`
  );
}

const fillers = suffix => [
  player(`wr-${suffix}`, "Steady WR", "WR", 30, 84),
  player(`rb-${suffix}`, "Steady RB", "RB", 32, 83),
  player(`te-${suffix}`, "Steady TE", "TE", 45, 79)
];

const lateFillers = suffix => [
  player(`late-wr-${suffix}`, "Late WR", "WR", 154, 68),
  player(`late-rb-${suffix}`, "Late RB", "RB", 158, 67),
  player(`late-te-${suffix}`, "Late TE", "TE", 162, 66)
];

runScenario({
  number: 1,
  name: "Pick 1 talent dominance",
  currentPick: 1,
  availablePlayers: [
    player("s1-rb", "Elite RB", "RB", 1, 98),
    player("s1-wr", "Elite WR", "WR", 2, 97),
    ...fillers("s1")
  ],
  check: result =>
    ["Elite RB", "Elite WR"].includes(result.best.player.name)
});

const bijanBoard = () => [
  player("bijan", "Bijan Robinson", "RB", 1, 97),
  player("gibbs", "Jahmyr Gibbs", "RB", 2, 96),
  player("allen", "Josh Allen", "QB", 20, 91, {
    scarcityValue: 10
  }),
  ...fillers("bijan")
];

runScenario({
  number: 2,
  name: "Elite RBs remain above quarterback",
  currentPick: 8,
  availablePlayers: bijanBoard(),
  check: result =>
    result.best.player.name === "Bijan Robinson" &&
    result.alternative.player.name === "Jahmyr Gibbs"
});

runScenario({
  number: 3,
  name: "Early QB run is meaningful but bounded",
  currentPick: 35,
  availablePlayers: [
    player("s3-wr", "Premium WR", "WR", 8, 94),
    player("s3-qb", "Josh Allen", "QB", 24, 91, {
      scarcityValue: 9
    }),
    ...fillers("s3")
  ],
  alerts: [{ position: "QB", draftedTopEndCount: 7 }],
  check: result => {
    const qb = result.scoredPlayers.find(
      candidate => candidate.player.position === "QB"
    );
    return (
      result.best.player.name === "Premium WR" &&
      qb.components.positionalRun > 0
    );
  }
});

runScenario({
  number: 4,
  name: "RB tier exhaustion",
  currentPick: 42,
  availablePlayers: [
    player("s4-rb1", "Final Tier RB", "RB", 12, 91, {
      fantasyProsTier: 2,
      scarcityValue: 8,
      nearbyAlternatives: 1
    }),
    player("s4-rb2", "Next Tier RB", "RB", 27, 84, {
      fantasyProsTier: 3
    }),
    player("s4-wr", "Comparable WR", "WR", 11, 91),
    ...fillers("s4")
  ],
  alerts: [{ position: "RB", draftedTopEndCount: 7 }],
  check: result => {
    const rb = result.scoredPlayers.find(
      candidate => candidate.player.name === "Final Tier RB"
    );
    return rb.fantasyProsTier.isCliff &&
      rb.components.fantasyProsTier > 0 &&
      result.reasons.some(reason =>
        reason.includes("Last Tier 2 RB")
      );
  }
});

runScenario({
  number: 5,
  name: "WR tier exhaustion",
  currentPick: 50,
  availablePlayers: [
    player("s5-wr1", "Final Tier WR", "WR", 18, 90, {
      fantasyProsTier: 3,
      scarcityValue: 7
    }),
    player("s5-wr2", "Next Tier WR", "WR", 31, 84, {
      fantasyProsTier: 4
    }),
    player("s5-rb", "Comparable RB", "RB", 17, 90),
    ...fillers("s5")
  ],
  alerts: [{ position: "WR", draftedTopEndCount: 6 }],
  check: result =>
    result.scoredPlayers.find(
      candidate => candidate.player.name === "Final Tier WR"
    ).fantasyProsTier.isCliff
});

runScenario({
  number: 6,
  name: "FLEX need accepts RB WR TE",
  currentPick: 70,
  currentRoster: roster({ QB: 1, RB: 2, WR: 2, TE: 1 }),
  availablePlayers: [
    player("s6-rb", "Flex RB", "RB", 70, 80),
    player("s6-wr", "Flex WR", "WR", 71, 80),
    player("s6-te", "Flex TE", "TE", 72, 80),
    ...fillers("s6")
  ],
  check: result =>
    ["RB", "WR", "TE"].every(position =>
      result.scoredPlayers.find(
        candidate =>
          candidate.player.name === `Flex ${position}`
      ).rosterNeed.needType === "flex"
    )
});

runScenario({
  number: 7,
  name: "Fixed WR need survives extra RB",
  currentPick: 75,
  currentRoster: roster({ RB: 3, WR: 1, TE: 1 }),
  availablePlayers: [
    player("s7-wr", "Needed WR", "WR", 76, 80),
    player("s7-rb", "Extra RB", "RB", 75, 80),
    ...fillers("s7")
  ],
  check: result => {
    const wr = result.scoredPlayers.find(
      candidate => candidate.player.name === "Needed WR"
    );
    const rb = result.scoredPlayers.find(
      candidate => candidate.player.name === "Extra RB"
    );
    return (
      wr.rosterNeed.needType === "fixed" &&
      wr.components.rosterNeed > rb.components.rosterNeed
    );
  }
});

runScenario({
  number: 8,
  name: "Middle-round upside and bust tiebreaker",
  currentPick: 90,
  availablePlayers: [
    player("s8-high", "Upside Choice", "WR", 90, 80, {
      fantasyProsUpside: 5,
      fantasyProsBust: 1,
      fantasyProsSos: 5
    }),
    player("s8-low", "Floor Choice", "WR", 89, 80, {
      fantasyProsUpside: 1,
      fantasyProsBust: 5,
      fantasyProsSos: 1
    }),
    player("s8-rb", "Middle RB", "RB", 92, 78),
    player("s8-te", "Middle TE", "TE", 94, 77),
    player("s8-wr", "Middle WR", "WR", 96, 76)
  ],
  check: result => {
    const high = result.scoredPlayers.find(
      candidate => candidate.player.name === "Upside Choice"
    );
    const low = result.scoredPlayers.find(
      candidate => candidate.player.name === "Floor Choice"
    );
    return high.components.fantasyProsUpside > 0 &&
      high.nextPickScore > low.nextPickScore &&
      high.nextPickScore - low.nextPickScore < 7 &&
      result.reasons.includes("5/5 FantasyPros upside");
  }
});

runScenario({
  number: 9,
  name: "ECR versus ADP survival urgency",
  currentPick: 85,
  availablePlayers: [
    player("s9-risk", "Market Risk", "WR", 86, 81, {
      fantasyProsEcrVsAdp: -20
    }),
    player("s9-wait", "Market Wait", "WR", 85, 81, {
      fantasyProsEcrVsAdp: 20
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      player(
        `s9-board-${index}`,
        `Market Board ${index + 1}`,
        index % 2 === 0 ? "RB" : "WR",
        79 + index,
        70
      )
    )
  ],
  check: result => {
    const risk = result.scoredPlayers.find(
      candidate => candidate.player.name === "Market Risk"
    );
    const wait = result.scoredPlayers.find(
      candidate => candidate.player.name === "Market Wait"
    );
    return risk.survival.label === "Take now" &&
      (
        wait.survival.label === "Could wait" ||
        wait.survival.label === "Risky to wait"
      ) &&
      risk.survival.riskScore > wait.survival.riskScore &&
      result.reasons.some(reason =>
        reason.includes("Market ADP")
      );
  }
});

runScenario({
  number: 10,
  name: "Single player tier cliff",
  currentPick: 65,
  availablePlayers: [
    player("s10-last", "Last Tier Player", "RB", 65, 83, {
      fantasyProsTier: 4
    }),
    player("s10-next", "Lower Tier Player", "RB", 82, 78, {
      fantasyProsTier: 5
    }),
    ...fillers("s10")
  ],
  check: result =>
    result.scoredPlayers.find(
      candidate => candidate.player.name === "Last Tier Player"
    ).components.fantasyProsTier > 0
});

runScenario({
  number: 11,
  name: "Questionable elite with reassuring context",
  currentPick: 20,
  availablePlayers: [
    player("s11-elite", "Reassuring Elite", "WR", 5, 95, {
      espnInjuryStatus: "Questionable",
      espnInjuryComment: "On track for Week 1 and expected to practice."
    }),
    player("s11-safe", "Healthy Peer", "WR", 7, 93),
    ...fillers("s11")
  ],
  check: result => {
    const elite = result.scoredPlayers.find(
      candidate => candidate.player.name === "Reassuring Elite"
    );
    return elite.injuryRisk.penalty === 0.5 &&
      result.best.player.name === "Reassuring Elite" &&
      result.reasons.some(reason =>
        reason.includes("reassuring readiness context")
      );
  }
});

runScenario({
  number: 12,
  name: "IR materially downgrades availability",
  currentPick: 25,
  availablePlayers: [
    player("s12-ir", "IR Player", "RB", 10, 93, {
      espnInjuryStatus: "Injured Reserve",
      espnInjuryComment: "Expected to miss at least six games."
    }),
    player("s12-safe", "Available Peer", "RB", 12, 91),
    ...fillers("s12")
  ],
  check: result => {
    const injured = result.scoredPlayers.find(
      candidate => candidate.player.name === "IR Player"
    );
    return injured.injuryRisk.penalty >= 6 &&
      result.best.player.name === "Available Peer";
  }
});

runScenario({
  number: 13,
  name: "Late-round asymmetric upside",
  currentPick: 145,
  currentRoster: roster({ QB: 1, RB: 3, WR: 3, TE: 1 }),
  availablePlayers: [
    player("s13-up", "Upside Bench RB", "RB", 151, 70, {
      fantasyProsUpside: 5,
      fantasyProsBust: 2
    }),
    player("s13-vet", "Mediocre Veteran", "RB", 145, 72, {
      fantasyProsUpside: 1,
      fantasyProsBust: 2
    }),
    ...lateFillers("s13")
  ],
  check: result =>
    result.scoredPlayers.findIndex(
      candidate => candidate.player.name === "Upside Bench RB"
    ) <
    result.scoredPlayers.findIndex(
      candidate => candidate.player.name === "Mediocre Veteran"
    )
});

runScenario({
  number: 14,
  name: "Reliable QB suppresses QB2",
  currentPick: 140,
  currentRoster: roster({ QB: 1, RB: 3, WR: 3, TE: 1 }),
  availablePlayers: [
    player("s14-qb", "Second Quarterback", "QB", 135, 78),
    player("s14-wr", "Bench Upside WR", "WR", 142, 75, {
      fantasyProsUpside: 5
    }),
    ...lateFillers("s14")
  ],
  check: result => {
    const qb = result.scoredPlayers.find(
      candidate => candidate.player.name === "Second Quarterback"
    );
    return qb.qbDepthSuppression > 0 &&
      result.best.player.name !== "Second Quarterback";
  }
});

runScenario({
  number: 15,
  name: "Missing late QB remains major need",
  currentPick: 140,
  currentRoster: roster({ RB: 3, WR: 3, TE: 1 }),
  availablePlayers: [
    player("s15-qb", "Starting Quarterback", "QB", 135, 78),
    player("s15-wr", "Bench WR", "WR", 138, 78),
    ...lateFillers("s15")
  ],
  check: result => {
    const qb = result.scoredPlayers.find(
      candidate => candidate.player.name === "Starting Quarterback"
    );
    return qb.rosterNeed.needType === "fixed" &&
      qb.components.rosterNeed >= 10 &&
      result.best.player.name === "Starting Quarterback";
  }
});

runScenario({
  number: 16,
  name: "Final-round K DEF become reasonable",
  currentPick: 169,
  currentRoster: roster({ QB: 1, RB: 3, WR: 2, TE: 1 }),
  availablePlayers: [
    player("s16-k", "Top Kicker", "K", 165, 72),
    player("s16-def", "Top Defense", "DEF", 168, 71),
    player("s16-wr", "Low Ceiling WR", "WR", 160, 65, {
      fantasyProsUpside: 1
    }),
    ...lateFillers("s16")
  ],
  check: result =>
    ["K", "DEF"].includes(result.best.player.position) &&
    result.best.rosterNeed.suppression === 0
});

runScenario({
  number: 17,
  name: "Missing injury record is unknown",
  currentPick: 80,
  availablePlayers: [
    player("s17", "No Injury Record", "WR", 80, 80),
    ...fillers("s17")
  ],
  check: result => {
    const risk = evaluateEspnInjuryRisk(
      result.best.player.name === "No Injury Record"
        ? result.best.player
        : result.scoredPlayers.find(
            candidate => candidate.player.name === "No Injury Record"
          ).player
    );
    return !risk.hasRecord && risk.penalty === 0 &&
      risk.classification === "Unknown";
  }
});

runScenario({
  number: 18,
  name: "Null supplemental fields remain neutral",
  currentPick: 80,
  availablePlayers: [
    player("s18-null", "Null Context Player", "RB", 80, 80, {
      fantasyProsTier: null,
      fantasyProsUpside: null,
      fantasyProsBust: null,
      fantasyProsSos: null,
      fantasyProsEcrVsAdp: null
    }),
    ...fillers("s18")
  ],
  check: (result, context) => {
    const candidate = calculateNextPickScore(
      context.availablePlayers.find(
        item => item.name === "Null Context Player"
      ),
      context
    );
    return Number.isFinite(candidate.nextPickScore) &&
      candidate.components.fantasyProsTier === 0 &&
      candidate.components.fantasyProsUpside === 0 &&
      candidate.components.fantasyProsBust === 0 &&
      candidate.components.espnInjury === 0;
  }
});

runScenario({
  number: 19,
  name: "Best Alternative elite-RB regression",
  currentPick: 8,
  availablePlayers: bijanBoard(),
  check: result =>
    result.best.player.name === "Bijan Robinson" &&
    result.alternative.player.name === "Jahmyr Gibbs"
});

runScenario({
  number: 20,
  name: "Full 15-player roster has no starter needs",
  currentPick: 180,
  currentRoster: roster({
    QB: 1,
    RB: 5,
    WR: 5,
    TE: 2,
    K: 1,
    DEF: 1
  }),
  availablePlayers: [
    player("s20-rb", "Depth RB", "RB", 180, 65),
    player("s20-wr", "Depth WR", "WR", 181, 65),
    player("s20-te", "Depth TE", "TE", 182, 65),
    player("s20-qb", "Depth QB", "QB", 183, 65),
    player("s20-k", "Second Kicker", "K", 184, 65)
  ],
  check: (result, context) =>
    context.rosterNeeds.allStartersFilled &&
    context.rosterNeeds.openRosterSpots === 0 &&
    result.scoredPlayers.every(
      candidate => !candidate.rosterNeed.isOpenNeed
    )
});

console.log("Recommendation stress suite report:");
for (const report of reports) {
  console.log(JSON.stringify(report));
}
console.log("All 20 recommendation stress scenarios passed.");

module.exports = reports;
