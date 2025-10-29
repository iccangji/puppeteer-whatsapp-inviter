import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { launchWorker, closeWorker, getWorker, getAllWorkers, cleanAllWorkers } from "./puppeteer.js";
import logger from "./utils/logger.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Worker } from "worker_threads";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workerPath = new URL("./worker.js", import.meta.url);

const app = express();
const PORT = process.env.PORT || 3000;
const profilesDir = "/data/profiles";
const inputsDir = "/data/inputs";
const upload = multer({ dest: "/tmp" });

const activeThreads = new Map();
// ensure folders
fs.mkdirSync(profilesDir, { recursive: true });
fs.mkdirSync(inputsDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// list profiles (folders) and running workers
app.get("/api/workers", (req, res) => {
  const profiles = fs.readdirSync(profilesDir)
    .filter(n => fs.lstatSync(path.join(profilesDir, n)).isDirectory())
    .map(n => ({ id: n.replace("worker", ""), name: n }));
  const running = getAllWorkers();
  res.json({ profiles, running });
});

// create profile (worker)
app.post("/api/workers", (req, res) => {
  const profiles = fs.readdirSync(profilesDir).filter(n => n.startsWith("worker"));
  const nextId = profiles.length + 1;
  const dir = path.join(profilesDir, `worker${nextId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tableFile = path.join(inputsDir, `worker${nextId}.xlsx`);
  if (!fs.existsSync(tableFile)) {
    const headers = [{ member: "", phone: "", group: "", status: "", timestamp: "" }];
    const ws = XLSX.utils.json_to_sheet(headers, { skipHeader: false });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, tableFile);
  }
  res.json({ success: true, id: nextId });
});

// delete profile (must be stopped)
app.delete("/api/workers/:id", async (req, res) => {
  const id = req.params.id;
  try {
    // if running, deny
    const running = getAllWorkers();
    if (running.includes(id)) return res.status(400).json({ success: false, message: "Worker is running. Stop it first." });
    const dir = path.join(profilesDir, `worker${id}`);
    const tableFile = path.join(inputsDir, `worker${id}.xlsx`);
    if (fs.existsSync(tableFile)) fs.unlinkSync(tableFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return res.json({ success: true });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// upload xlsx for worker
app.post("/api/workers/:id/upload", upload.single("xlsx"), (req, res) => {
  const id = req.params.id;
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ success: false, message: "No file" });
    const dest = path.join(inputsDir, `worker${id}.xlsx`);
    fs.copyFileSync(file.path, dest);
    fs.unlinkSync(file.path);
    res.json({ success: true });
  } catch (e) {
    logger.error(e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// start worker: ensure profile exists and launch QR browser (if needed) then run worker loop
app.post("/api/workers/:id/start", async (req, res) => {
  const id = req.params.id;
  logger.info(`🚀 Starting worker ${id}...`);
  try {
    // ensure profile dir exists
    const profileDir = path.join(profilesDir, `worker${id}`);
    if (!fs.existsSync(profileDir)) return res.status(404).json({ success: false, message: "Profile not found. Create worker first." });

    // launch browser & QR page (if not already launched) via puppeteer.launchWorker
    const worker = await launchWorker(id);
    if (!worker) return res.status(500).json({ success: false, message: "Failed to launch browser for QR." });

    await new Promise(r => setTimeout(r, 10 * 1000));

    // return QR to client so they can scan
    res.json({ success: true, qr: `data:image/png;base64,${worker.qrBase64}` });
  } catch (e) {
    logger.error(e);
  }
});

app.post("/api/workers/:id/run", async (req, res) => {
  const id = req.params.id;

  try {
    await closeWorker(id);
    logger.info(`🚀 Worker ${id} running, check worker log...`);
    const thread = new Worker(workerPath, { workerData: { id } });
    activeThreads.set(id, thread);

    thread.on("online", () => logger.info(`🟢 Automation Worker ${id} running`));

    thread.on("message", async msg => {
      activeThreads.delete(msg.id);
      const ok = await closeWorker(id);
      if (ok) {
        if (msg.done) {
          logger.info(`🟢 Automation Worker ${id} done`);
        } else {
          logger.error(`❌ Automation Worker ${id} failed`);
        }
      };
    });

    res.json({ success: true, message: "Worker started" });
  } catch (e) {
    logger.error(e);
  }
});

// stop worker (and close browser)
app.post("/api/workers/:id/stop", async (req, res) => {
  const id = req.params.id;
  try {
    const thread = activeThreads.get(id);

    if (thread) {
      thread.terminate();
      activeThreads.delete(id);
      logger.info(`🛑 Worker ${id} has terminated`);
    }
  } catch (e) {
    logger.error(e);
  }
  const ok = await closeWorker(id);
  if (ok) {
    logger.info(`Worker ${id} stopped`)
    res.json({ success: !!ok });
  }
});

// get worker QR (poll)
app.get("/api/workers/:id/qr", (req, res) => {
  const id = req.params.id;
  const worker = getWorker(id);
  if (!worker) return res.json({ qr: null });
  res.json({ qr: worker.qrBase64 ? `data:image/png;base64,${worker.qrBase64}` : null, lastUpdate: worker.lastUpdate });
});

app.get("/workers/:id/logs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "logs.html"));
})

// logs (simple tail of log file)
app.get("/api/workers/:id/logs", (req, res) => {
  const id = req.params.id;
  try {
    const logFile = path.join("/data/logs", `worker${id}.log`);
    if (!fs.existsSync(logFile)) return res.json({ logs: [] });
    const content = fs.readFileSync(logFile, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    const logs = allLines.slice(-50);

    res.json({ logs });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// close all workers
app.post("/api/workers/close-all", async (req, res) => {
  try {
    const activeWorkers = Array.from(activeThreads.keys());
    for (const id of activeWorkers) {
      activeThreads.delete(id);
    }

    const workers = getAllWorkers();
    for (const id of workers) {
      await closeWorker(id);
    }

    const ok = cleanAllWorkers();
    if (ok) res.json({ success: true });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// View and download table
app.get("/workers/:id/table", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "table.html"));
})

app.get("/api/workers/:id/table/view", async (req, res) => {
  const id = req.params.id;
  const tableFile = path.join(inputsDir, `worker${id}.xlsx`);

  if (!fs.existsSync(tableFile)) {
    return res.status(404).json({ error: `worker${id}.xlsx not found` });
  }

  try {
    const workbook = XLSX.readFile(tableFile);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const headers = Object.keys(rows[0] || {});
    res.json({ headers, rows, id });
  } catch (err) {
    logger.error(`Error view table ${err}`);
    res.status(500).json({ error: "Failed to read XLSX file" });
  }
});

app.get("/api/workers/:id/table/download", async (req, res) => {
  const id = req.params.id;
  const tableFile = path.join(inputsDir, `worker${id}.xlsx`);

  if (!fs.existsSync(tableFile)) {
    return res.status(404).send("File not found");
  }

  res.download(tableFile);
});

app.listen(PORT, () => {
  logger.info(`Dashboard: http://localhost:${PORT}`);
});

