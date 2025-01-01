const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./database");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
  session({
    secret: "mySecretKey",
    resave: false,
    saveUninitialized: true,
  })
);
app.set("view engine", "ejs");

const checkAuth = (req, res, next) => {
  if (req.session.currentUser) return next();
  res.redirect("/login");
};

const restrictPastSessions = (req, res, next) => {
  const { sessionId } = req.body;
  db.query("SELECT * FROM sessions WHERE id = $1", [sessionId], (error, result) => {
    if (
      error ||
      !result.rows.length ||
      new Date(result.rows[0].date) < new Date()
    ) {
      return res.redirect("/player-dashboard");
    }
    next();
  });
};

app.get("/", (req, res) => res.render("home"));

app.get("/login", (req, res) => res.render("login"));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const userQuery = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  if (userQuery.rows.length) {
    const user = userQuery.rows[0];
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (isPasswordCorrect) {
      req.session.currentUser = user;
      return res.redirect(user.role === "admin" ? "/admin-dashboard" : "/player-dashboard");
    }
  }
  res.redirect("/login?error=Invalid+credentials");
});

app.get("/register", (req, res) => res.render("register"));

app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  const encryptedPassword = await bcrypt.hash(password, 10);
  await db.query(
    "INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)",
    [name, email, encryptedPassword, role]
  );
  res.redirect("/login");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.get("/admin-dashboard", checkAuth, async (req, res) => {
  const sportsList = await db.query("SELECT * FROM sports");
  const sessionsData = await db.query(
    `SELECT sessions.*, sports.name AS sportName, users.name AS createdBy 
     FROM sessions 
     JOIN sports ON sessions.sport_id = sports.id 
     JOIN users ON sessions.creator_id = users.id`
  );

  const detailedSessions = await Promise.all(
    sessionsData.rows.map(async (session) => {
      const players = await db.query(
        `SELECT users.name, users.id FROM session_players 
         JOIN users ON session_players.player_id = users.id 
         WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );

  res.render("admin-dashboard", {
    user: req.session.currentUser,
    sports: sportsList.rows,
    sessions: detailedSessions,
  });
});

app.post("/add-sport", checkAuth, async (req, res) => {
  const { name } = req.body;
  await db.query("INSERT INTO sports (name) VALUES ($1)", [name]);
  res.redirect("/admin-dashboard");
});

app.post("/remove-session", checkAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || isNaN(sessionId)) return res.status(400).send("Invalid session ID");

  await db.query("DELETE FROM session_players WHERE session_id = $1", [sessionId]);
  const deletionResult = await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);

  if (!deletionResult.rowCount) return res.status(404).send("Session not found");
  res.redirect("/admin-dashboard");
});

app.get("/player-dashboard", checkAuth, async (req, res) => {
  const userId = req.session.currentUser.id;

  const availableSessions = await db.query(
    `SELECT sessions.*, sports.name AS sportName 
     FROM sessions 
     JOIN sports ON sessions.sport_id = sports.id`
  );

  const userJoinedSessions = await db.query(
    `SELECT sessions.*, sports.name AS sportName 
     FROM sessions 
     JOIN sports ON sessions.sport_id = sports.id 
     JOIN session_players ON sessions.id = session_players.session_id 
     WHERE session_players.player_id = $1`,
    [userId]
  );

  const availableSessionsWithPlayers = await Promise.all(
    availableSessions.rows.map(async (session) => {
      const players = await db.query(
        `SELECT users.name, users.id FROM session_players 
         JOIN users ON session_players.player_id = users.id 
         WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );

  const joinedSessionsWithPlayers = await Promise.all(
    userJoinedSessions.rows.map(async (session) => {
      const players = await db.query(
        `SELECT users.name, users.id FROM session_players 
         JOIN users ON session_players.player_id = users.id 
         WHERE session_players.session_id = $1`,
        [session.id]
      );
      return { ...session, players: players.rows };
    })
  );

  const sportsList = await db.query("SELECT * FROM sports");
  res.render("player-dashboard", {
    user: req.session.currentUser,
    sessions: availableSessionsWithPlayers,
    joinedSessions: joinedSessionsWithPlayers,
    sports: sportsList.rows,
  });
});

app.post("/create-session", checkAuth, async (req, res) => {
  const { sportId, teamOne, teamTwo, extraPlayers, sessionDate, location } = req.body;
  try {
    await db.query(
      "INSERT INTO sessions (sport_id, creator_id, team1, team2, additional_players, date, venue) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        sportId,
        req.session.currentUser.id,
        teamOne,
        teamTwo,
        extraPlayers,
        sessionDate,
        location,
      ]
    );
    res.redirect(
      req.session.currentUser.role === "admin" ? "/admin-dashboard" : "/player-dashboard"
    );
  } catch {
    res.redirect(
      req.session.currentUser.role === "admin"
        ? "/admin-dashboard?error=Session+creation+failed"
        : "/player-dashboard?error=Session+creation+failed"
    );
  }
});

app.post("/join-session", checkAuth, restrictPastSessions, async (req, res) => {
  const { sessionId } = req.body;
  const userId = req.session.currentUser.id;

  const existingJoin = await db.query(
    "SELECT * FROM session_players WHERE session_id = $1 AND player_id = $2",
    [sessionId, userId]
  );

  if (existingJoin.rows.length)
    return res.redirect(
      req.session.currentUser.role === "admin" ? "/admin-dashboard" : "/player-dashboard"
    );

  await db.query("INSERT INTO session_players (session_id, player_id) VALUES ($1, $2)", [sessionId, userId]);
  res.redirect(
    req.session.currentUser.role === "admin" ? "/admin-dashboard" : "/player-dashboard"
  );
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
