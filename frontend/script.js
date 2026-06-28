const leaderboardData = {
    rank: 1,
    region: "EU",
    mmr: 12121,
    sessionRankChange: -1,
    sessionMMRChange: -50
};
function renderOverlay() {

document.getElementById("rank").textContent = `#${leaderboardData.rank}`;

document.getElementById("region").textContent = leaderboardData.region;

document.getElementById("mmr").textContent = `${leaderboardData.mmr} MMR`;

const rankChange =
  leaderboardData.sessionRankChange;

const mmrChange =
  leaderboardData.sessionMMRChange;
  const rankElement =
  document.getElementById("session-rank");

const mmrElement =
  document.getElementById("session-mmr");

rankElement.classList.remove(
  "positive",
  "negative"
);

mmrElement.classList.remove(
  "positive",
  "negative"
);

if (rankChange > 0) {
  rankElement.classList.add("positive");
}
else if (rankChange < 0) {
  rankElement.classList.add("negative");
}

if (mmrChange > 0) {
  mmrElement.classList.add("positive");
}
else if (mmrChange < 0) {
  mmrElement.classList.add("negative");
}

rankElement.textContent =
  `${rankChange >= 0 ? "▲" : "▼"} Rank ${Math.abs(rankChange)}`;

mmrElement.textContent =
  `${mmrChange >= 0 ? "▲" : "▼"} MMR ${Math.abs(mmrChange)}`;
}
async function loadLeaderboard() {
const url = new URL(window.location.href);

const region =
  url.searchParams.get("region") || "EU";
  const apiRegion =
  region === "NA" ? "US" : region;

const account =
  url.searchParams.get("account") || "lagshya";
const response = await fetch(
  `/player?region=${apiRegion}&account=${account}`
);
console.log(response.status);
const player = await response.json();

leaderboardData.rank = player.rank;
leaderboardData.mmr = player.rating;

leaderboardData.sessionRankChange =
  player.sessionRankChange;

leaderboardData.sessionMMRChange =
  player.sessionMMRChange;

leaderboardData.region =
  region === "US" ? "NA" : region;


    renderOverlay();
}

loadLeaderboard();

setInterval(() => {

  loadLeaderboard();

}, 60 * 1000);