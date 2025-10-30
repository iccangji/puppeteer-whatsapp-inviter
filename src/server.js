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
import { Server } from "socket.io";
import http from "http";
import bcrypt from "bcrypt";
import session from "express-session";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workerPath = new URL("./worker.js", import.meta.url);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const profilesDir = "/data/profiles";
const inputsDir = "/data/inputs";
const upload = multer({ dest: "/tmp" });

const activeThreads = new Map();

// ensure folders
fs.mkdirSync(profilesDir, { recursive: true });
fs.mkdirSync(inputsDir, { recursive: true });
app.use(express.urlencoded({ extended: true }));

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 } // 1 hour
  })
);

// Middleware
function requireLogin(req, res, next) {
  const isLoginPage = req.path === "/login.html" || req.path === "/login";
  if (isLoginPage) return next();

  if (req.session.loggedIn) return next();
  res.redirect("/login");
}

app.use(requireLogin);
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", async (req, res) => {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const { username, password } = req.body;
  if (username !== adminUsername) return res.send("<script>alert('Invalid username');window.location='/login';</script>");

  const valid = await bcrypt.compare(password, adminPassword);
  if (valid) {
    req.session.loggedIn = true;
    return res.redirect("/");
  }

  res.send("<script>alert('Invalid password');window.location='/login';</script>");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

io.on("connection", (socket) => {
  const baseLogDir = "/data/logs";

  // When the frontend wants to watch a worker’s log
  socket.on("watchWorker", (id) => {
    const logFile = path.join(baseLogDir, `worker-main.log`);

    // If no log file exists, notify the client
    if (!fs.existsSync(logFile)) {
      socket.emit("workerStatus", { id, status: "no log file" });
      return;
    }

    // Send initial status from the last line containing "Worker {id}"
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const matchLines = lines.filter((l) => l.includes(`Worker ${id}`));
    if (matchLines.length > 0) {
      const last = matchLines[matchLines.length - 1];
      const parts = last.split(`Worker ${id}`);
      const status = parts[1]?.trim() || "idle";
      socket.emit("workerStatus", { id, status });
    } else {
      socket.emit("workerStatus", { id, status: "idle" });
    }

    fs.watchFile(logFile, { interval: 1000 }, () => {
      try {
        const content = fs.readFileSync(logFile, "utf8").trim().split("\n");
        const matchLines = content.filter((l) => l.includes(`Worker ${id}`));
        if (matchLines.length > 0) {
          const last = matchLines[matchLines.length - 1];
          const parts = last.split(`Worker ${id}`);
          const status = parts[1]?.trim() || "idle";
          socket.emit("workerStatus", { id, status });
        } else {
          socket.emit("workerStatus", { id, status: "idle" });
        }
      } catch (err) {
        logger.error("⚠️ Error reading log:", err);
      }
    });
  });

  // When the frontend wants to watch a worker’s log
  socket.on("watchLogs", () => {
    const logFile = path.join(baseLogDir, `worker-main.log`);

    // If no log file exists, notify the client
    if (!fs.existsSync(logFile)) {
      socket.emit("mainLogs", { logs: "no log file" });
      return;
    }

    // Send initial status from the last line containing "Worker {id}"    
    const content = fs.readFileSync(logFile, "utf8");
    const logs = content.split("\n").filter(Boolean).slice(-100);
    socket.emit("mainLogs", { logs });

    fs.watchFile(logFile, { interval: 1000 }, () => {
      try {
        const content = fs.readFileSync(logFile, "utf8");
        const logs = content.split("\n").filter(Boolean).slice(-100);
        socket.emit("mainLogs", { logs });
      } catch (err) {
        logger.error("⚠️ Error reading log:", err);
      }
    });
  });

  // When the frontend wants to watch a worker’s log
  socket.on("watchWorkerLogs", (id) => {
    const logFile = path.join(baseLogDir, `worker${id}.log`);

    // If no log file exists, notify the client
    if (!fs.existsSync(logFile)) {
      socket.emit("workerLogs", { logs: "no log file" });
      return;
    }

    // Send initial status from the last line containing "Worker {id}"    
    const content = fs.readFileSync(logFile, "utf8");
    const logs = content.split("\n").filter(Boolean);
    socket.emit("workerLogs", { logs });

    fs.watchFile(logFile, { interval: 1000 }, () => {
      try {
        const content = fs.readFileSync(logFile, "utf8");
        const logs = content.split("\n").filter(Boolean);
        socket.emit("workerLogs", { logs });
      } catch (err) {
        logger.error("⚠️ Error reading log:", err);
      }
    });
  });

  socket.on("disconnect", () => { });
});

// list profiles (folders) and running workers (HTTP requests)
app.get("/api/workers", (req, res) => {
  const baseLogDir = "/data/logs";
  const profiles = fs.readdirSync(profilesDir)
    .filter(n => fs.lstatSync(path.join(profilesDir, n)).isDirectory())
    .map(n => {
      const id = n.replace("worker", "");
      const logFile = path.join(baseLogDir, `worker${id}.log`);
      let status = "Idle";
      let lastLine = "";

      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, "utf8").trim();
        const lines = content.split("\n").filter(Boolean);

        const target = [...lines].reverse().find(line => line.includes(`Worker ${id}`));

        if (target) {
          lastLine = target;
          const regex = new RegExp(`Worker\\s+${id}\\s+(\\S+)`, "i");
          const match = target.match(regex);
          if (match && match[1]) {
            status = match[1].replace(/[^a-zA-Z]/g, "");
          }
        }
      }

      const tableFile = path.join(inputsDir, `worker${id}.xlsx`);
      const isTableExist = fs.existsSync(tableFile)

      return { id, name: n, status, lastLine, isTableExist };
    });

  const running = getAllWorkers();
  res.json({ profiles, running });
});

// create profile (worker)
app.post("/api/workers", (req, res) => {
  const profiles = fs.readdirSync(profilesDir)
    .filter(n => n.startsWith("worker") && n !== "worker-main")
    .map(n => parseInt(n.replace("worker", ""), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  let nextId = 1;
  for (const id of profiles) {
    if (id === nextId) nextId++;
    else break;
  }

  const dir = path.join(profilesDir, `worker${nextId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const config = {
    delayRandomStart: 0,
    delayRandomEnd: 0
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
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

// clear profile (must be stopped)
app.post("/api/workers/:id/clear", async (req, res) => {
  const id = req.params.id;
  try {
    // if running, deny
    const running = getAllWorkers();
    if (running.includes(id)) return res.status(400).json({ success: false, message: "Worker is running. Stop it first." });
    const dir = path.join(profilesDir, `worker${id}`);
    const tableFile = path.join(inputsDir, `worker${id}.xlsx`);
    const logFile = path.join(baseLogDir, `worker${id}.log`)
    if (fs.existsSync(tableFile)) fs.unlinkSync(tableFile);
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
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
  logger.info(`🚀 Worker ${id} starting`);
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
    const thread = new Worker(workerPath, { workerData: { id } });
    activeThreads.set(id, thread);

    thread.on("online", () => logger.info(`🟢 Automation Worker ${id} running`));

    thread.on("message", async msg => {
      activeThreads.delete(msg.id);
      const ok = await closeWorker(id);
      if (ok) {
        if (msg.done) {
          logger.info(`🟢 Worker ${id} done`);
        } else {
          logger.error(`❌ Worker ${id} error`);
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
    }
  } catch (e) {
    logger.error(e);
  }
  const ok = await closeWorker(id);
  if (ok) {
    logger.info(`🛑 Worker ${id} stopped`);
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
  if (id === '-main') {
    res.status(400).json({ success: false, message: "Invalid worker ID" });
  }
  try {
    const logFile = path.join("/data/logs", `worker${id}.log`);
    if (!fs.existsSync(logFile)) return res.json({ logs: [] });
    const content = fs.readFileSync(logFile, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    const logs = (id === "-main") ? allLines.slice(-100) : allLines;

    res.json({ logs });
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

// View and edit config delay time
app.get("/workers/:id/config", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "config.html"));
})

app.get("/api/workers/:id/config", (req, res) => {
  const id = req.params.id;
  const configPath = path.join(profilesDir, `worker${id}`, "config.json");

  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ success: false, message: "Config not found" });
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  res.json({ success: true, id, config });
});

// update config for a worker
app.post("/api/workers/:id/config", (req, res) => {
  const id = req.params.id;
  const configPath = path.join(profilesDir, `worker${id}`, "config.json");

  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ success: false, message: "Config not found" });
  }

  const { delayRandomStart, delayRandomEnd } = req.body;
  if (!delayRandomStart || !delayRandomEnd) {
    return res
      .status(400)
      .json({ success: false, message: "Missing delayRandomStart or delayRandomEnd" });
  }

  const newConfig = {
    delayRandomStart,
    delayRandomEnd
  };

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

  res.json({
    success: true,
    id,
    config: newConfig,
  });
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

httpServer.listen(PORT, async () => {
  logger.info(`Dashboard: http://localhost:${PORT}`);
});