const league = {
  name: "The Benchwarmers",
  platform: "Yahoo",
  teams: 12,
  scoring: {
    format: "Head-to-Head",
    ppr: 0,
    passingYardsPerPoint: 20,
    passingTouchdown: 6,
    interception: -1,
    rushingYardsPerPoint: 10,
    rushingTouchdown: 6,
    receivingYardsPerPoint: 10,
    receivingTouchdown: 6
  },
  rosterPositions: [
    "QB",
    "WR",
    "WR",
    "RB",
    "RB",
    "TE",
    "W/R/T",
    "K",
    "DEF",
    "BN",
    "BN",
    "BN",
    "BN",
    "BN",
    "BN"
  ]
};

const teams = {
  preston: {
    owner: "Preston",
    name: "That's What She Said",
    roster: []
  },
  trena: {
    owner: "Trena",
    name: "Tinkerbell",
    roster: []
  }
};

module.exports = {
  league,
  teams
};