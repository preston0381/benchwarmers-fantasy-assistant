(function createRosterNeedsModule() {
  const FIXED_STARTER_TARGETS = Object.freeze({
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    K: 1,
    DEF: 1
  });
  const FLEX_ELIGIBLE_POSITIONS = Object.freeze([
    "RB",
    "WR",
    "TE"
  ]);
  const FLEX_STARTER_TARGET = 1;
  const FLEX_ELIGIBLE_STARTER_TOTAL = 6;
  const FLEX_NEED_RATIO = 0.6;
  const STARTER_SPOTS = 9;
  const BENCH_SPOTS = 6;
  const TOTAL_ROSTER_SPOTS = 15;

  function normalizePosition(position) {
    return String(position || "")
      .trim()
      .toUpperCase();
  }

  function countRosterPositions(roster) {
    return (roster || []).reduce(
      (counts, player) => {
        const position =
          normalizePosition(player.position);

        counts[position] =
          (counts[position] || 0) + 1;

        return counts;
      },
      {}
    );
  }

  function analyzeRosterNeeds(roster) {
    const positionCounts =
      countRosterPositions(roster);
    const fixedMissing = Object.fromEntries(
      Object.entries(FIXED_STARTER_TARGETS).map(
        ([position, target]) => [
          position,
          Math.max(
            0,
            target - (positionCounts[position] || 0)
          )
        ]
      )
    );
    const flexEligibleCount =
      FLEX_ELIGIBLE_POSITIONS.reduce(
        (total, position) =>
          total + (positionCounts[position] || 0),
        0
      );
    const flexBaseFilled =
      FLEX_ELIGIBLE_POSITIONS.every(position =>
        (positionCounts[position] || 0) >=
        FIXED_STARTER_TARGETS[position]
      );
    const flexOpen =
      flexBaseFilled &&
      flexEligibleCount < FLEX_ELIGIBLE_STARTER_TOTAL;
    const flexFilled =
      flexBaseFilled &&
      flexEligibleCount >= FLEX_ELIGIBLE_STARTER_TOTAL;
    const fixedStartersFilled =
      Object.values(fixedMissing).every(
        missing => missing === 0
      );
    const coreOffenseFilled =
      fixedMissing.QB === 0 &&
      flexFilled;

    return {
      positionCounts,
      fixedMissing,
      flexEligibleCount,
      flexBaseFilled,
      flexOpen,
      flexFilled,
      fixedStartersFilled,
      coreOffenseFilled,
      allStartersFilled:
        fixedStartersFilled && flexFilled,
      openRosterSpots:
        Math.max(
          0,
          TOTAL_ROSTER_SPOTS - (roster || []).length
        )
    };
  }

  function getPositionNeed(rosterOrAnalysis, position) {
    const analysis =
      rosterOrAnalysis && rosterOrAnalysis.positionCounts
        ? rosterOrAnalysis
        : analyzeRosterNeeds(rosterOrAnalysis);
    const normalizedPosition =
      normalizePosition(position);
    const target =
      FIXED_STARTER_TARGETS[normalizedPosition] || 0;
    const currentCount =
      analysis.positionCounts[normalizedPosition] || 0;
    const fixedMissing =
      analysis.fixedMissing[normalizedPosition] || 0;
    const fixedNeedRatio = target
      ? fixedMissing / target
      : 0;
    const flexEligible =
      FLEX_ELIGIBLE_POSITIONS.includes(
        normalizedPosition
      );

    let needType = "bench";

    if (fixedMissing > 0) {
      needType = "fixed";
    } else if (flexEligible && analysis.flexOpen) {
      needType = "flex";
    }

    const needWeight =
      needType === "fixed"
        ? fixedNeedRatio
        : needType === "flex"
          ? FLEX_NEED_RATIO
          : 0;

    return {
      position: normalizedPosition,
      target,
      currentCount,
      fixedMissing,
      fixedNeedRatio,
      flexEligible,
      flexOpen: analysis.flexOpen,
      flexFilled: analysis.flexFilled,
      needType,
      needWeight,
      isOpenNeed:
        needType === "fixed" || needType === "flex"
    };
  }

  const api = Object.freeze({
    FIXED_STARTER_TARGETS,
    FLEX_ELIGIBLE_POSITIONS,
    FLEX_STARTER_TARGET,
    FLEX_ELIGIBLE_STARTER_TOTAL,
    FLEX_NEED_RATIO,
    STARTER_SPOTS,
    BENCH_SPOTS,
    TOTAL_ROSTER_SPOTS,
    normalizePosition,
    countRosterPositions,
    analyzeRosterNeeds,
    getPositionNeed
  });

  if (
    typeof module !== "undefined" &&
    module.exports
  ) {
    module.exports = api;
  }

  if (typeof window !== "undefined") {
    window.BenchwarmersRosterNeeds = api;
  }
})();
