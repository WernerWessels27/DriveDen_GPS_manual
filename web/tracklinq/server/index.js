import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";

const app = express();
app.use(express.json());
app.use(morgan("tiny"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TrackLinq server running on :${PORT}`));
