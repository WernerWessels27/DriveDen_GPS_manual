import pkg from "pg";
const { Pool } = pkg;

// Railway provides DATABASE_URL (you already added it).
// SSL is required on most hosted Postgres.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export const query = (text, params) => pool.query(text, params);

