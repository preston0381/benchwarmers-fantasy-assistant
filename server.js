const express = require("express");
const path = require("path");
require("dotenv").config();
const { league, teams } = require("./data");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Benchwarmers Fantasy Assistant"
  });
});
app.get("/api/league", (req, res) => {
  res.json(league);
});

app.get("/api/teams", (req, res) => {
  res.json(teams);
});
app.listen(PORT, () => {
  console.log(`Benchwarmers Fantasy Assistant is running at http://localhost:${PORT}`);
});