const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const pool = require("./database");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
  session({
    secret: "secret",
    resave: false,
    saveUninitialized: true,
  })
);
app.set("view engine", "ejs");

function isAuthenticated(req, res, next) {
  if (req.session.user) next();
  else res.redirect("/login");
}

function preventJoiningPastSessions(req, res, next) {
  const { session_id } = req.body;
  pool.query("SELECT * FROM sessions WHERE id = $1", [session_id], (err, result) => {
    if (err || !result.rows.length || new Date(result.rows[0].date) < new Date()) {
      return res.redirect("/player-dashboard");
    }
    next();
  });
}

app.get("/", (req, res) => res.render("home"));

app.get("/login", (req, res) => res.render("login"));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  if (userResult.rows.length > 0) {
    const user = userResult.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = user;
      return res.redirect(user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
    }
  }
  res.redirect("/login?error=Invalid+email+or+password");
});

app.get("/register", (req, res) => res.render("register"));

app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)",
    [name, email, hashedPassword, role]
  );
  res.redirect("/login");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.get("/admin-dashboard", isAuthenticated, async (req, res) => {
  const sports = await pool.query("SELECT * FROM sports");
  const sessions = await pool.query(`
    SELECT sessions.*, sports.name AS sport_name, users.name AS creator_name
    FROM sessions
    JOIN sports ON sessions.sport_id = sports.id
    JOIN users ON sessions.creator_id = users.id
  `);
  const sessionsWithPlayers = await Promise.all(
    sessions.rows.map(async (session) => {
      const players = await pool.query(
        `SELECT users.name, users.id FROM session_players JOIN users ON session_players.player_id = users.id WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );
  res.render("admin-dashboard", { user: req.session.user, sports: sports.rows, sessions: sessionsWithPlayers });
});

app.post("/create-sport", isAuthenticated, async (req, res) => {
  const { name } = req.body;
  await pool.query("INSERT INTO sports (name) VALUES ($1)", [name]);
  res.redirect("/admin-dashboard");
});

app.post("/delete-session", isAuthenticated, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id || isNaN(session_id)) return res.status(400).send("Invalid session ID");
  const sessionIdInt = parseInt(session_id);
  await pool.query("DELETE FROM session_players WHERE session_id = $1", [sessionIdInt]);
  const result = await pool.query("DELETE FROM sessions WHERE id = $1", [sessionIdInt]);
  if (result.rowCount === 0) return res.status(404).send("Session not found");
  res.redirect("/admin-dashboard");
});

app.get("/player-dashboard", isAuthenticated, async (req, res) => {
  const user_id = req.session.user.id;
  const sessions = await pool.query(`
    SELECT sessions.*, sports.name AS sport_name
    FROM sessions
    JOIN sports ON sessions.sport_id = sports.id
  `);
  const joinedSessions = await pool.query(
    `SELECT sessions.*, sports.name AS sport_name FROM sessions JOIN sports ON sessions.sport_id = sports.id JOIN session_players ON sessions.id = session_players.session_id WHERE session_players.player_id = $1`,
    [user_id]
  );
  const sessionsWithPlayers = await Promise.all(
    sessions.rows.map(async (session) => {
      const players = await pool.query(
        `SELECT users.name, users.id FROM session_players JOIN users ON session_players.player_id = users.id WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );
  const joinedSessionsWithPlayers = await Promise.all(
    joinedSessions.rows.map(async (session) => {
      const players = await pool.query(
        `SELECT users.name, users.id FROM session_players JOIN users ON session_players.player_id = users.id WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );
  const sports = await pool.query("SELECT * FROM sports");
  res.render("player-dashboard", {
    user: req.session.user,
    sessions: sessionsWithPlayers,
    joinedSessions: joinedSessionsWithPlayers,
    sports: sports.rows,
  });
});

app.post("/create-session", isAuthenticated, async (req, res) => {
  const { sport_id, team1, team2, additional_players, date, venue } = req.body;
  try {
    await pool.query(
      "INSERT INTO sessions (sport_id, creator_id, team1, team2, additional_players, date, venue) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [sport_id, req.session.user.id, team1, team2, additional_players, date, venue]
    );
    res.redirect(req.session.user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
  } catch (error) {
    res.redirect(
      req.session.user.role === "admin"
        ? "/admin-dashboard?error=Failed+to+create+session"
        : "/player-dashboard?error=Failed+to+create+session"
    );
  }
});

app.post("/join-session", isAuthenticated, preventJoiningPastSessions, async (req, res) => {
  const { session_id } = req.body;
  const user_id = req.session.user.id;
  const existing = await pool.query(
    "SELECT * FROM session_players WHERE session_id = $1 AND player_id = $2",
    [session_id, user_id]
  );
  if (existing.rows.length > 0) return res.redirect(req.session.user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
  await pool.query("INSERT INTO session_players (session_id, player_id) VALUES ($1, $2)", [session_id, user_id]);
  res.redirect(req.session.user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
});

app.post("/cancel-session", isAuthenticated, async (req, res) => {
  const { session_id, reason } = req.body;
  const user_id = req.session.user.id;
  const session = await pool.query(
    "SELECT * FROM sessions WHERE id = $1 AND creator_id = $2",
    [session_id, user_id]
  );
  if (session.rows.length > 0) {
    await pool.query(
      "UPDATE sessions SET cancelled = TRUE, cancellation_reason = $1 WHERE id = $2",
      [reason, session_id]
    );
  }
  res.redirect(req.session.user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
});

app.get("/change-password", isAuthenticated, (req, res) => {
  const { error, success } = req.query;
  res.render("change-password", { error, success });
});

app.post("/change-password", isAuthenticated, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = req.session.user;
  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) return res.redirect("/change-password?error=Incorrect+current+password");
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hashedPassword, user.id]);
  res.redirect("/change-password?success=Password+changed+successfully");
});

app.get("/reports", isAuthenticated, async (req, res) => {
  try {
    const sessions = await pool.query(`
      SELECT sessions.*, sports.name AS sport_name
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
    `);
    const popularity = await pool.query(`
      SELECT sports.name, COUNT(sessions.id) AS count
      FROM sessions
      JOIN sports ON sessions.sport_id = sports.id
      GROUP BY sports.name
    `);
    res.render("reports", { sessions: sessions.rows, popularity: popularity.rows });
  } catch {
    res.status(500).send("An error occurred while fetching reports.");
  }
});

app.listen(3000, () => console.log("Server is running on http://localhost:3000"));
