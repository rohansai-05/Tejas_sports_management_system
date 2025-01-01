const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "sports_management",
  password: "22PA1A4541",
  port: 5432,
});
pool
  .connect()
  .then(() => console.log("PostgreSQL connected"))
  .catch((err) => console.error("Error connecting to PostgreSQL", err));

module.exports = pool;
