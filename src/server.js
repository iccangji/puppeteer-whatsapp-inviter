import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { launchWorker, closeWorker, getWorker, getAllWorkers, cleanAllWorkers } from "./puppeteer.js";
import { createLogger } from "./utils/logger.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Worker } from "worker_threads";
import XLSX from "xlsx";
import { Server } from "socket.io";
import http, { get } from "http";
import bcrypt from "bcrypt";
import session from "express-session";
import { getQueueSize, updateConfig } from "./utils/config.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workerPath = new URL("./worker.js", import.meta.url);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const profilesDir = "/data/profiles";
const inputsDir = "/data/inputs";
const configDir = "/data/config";
const baseLogDir = "/data/logs";

const upload = multer({ dest: "/tmp" });
const activeThreads = new Map();
const logger = createLogger();
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
  const userData = fs.readFileSync(path.join(configDir, "user.json"), "utf8");
  const user = JSON.parse(userData);
  const adminUsername = user.username;
  const adminPassword = user.password_hash;
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

app.get("/change-password", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "change-password.html"));
})

app.post("/api/change-password", requireLogin, async (req, res) => {
  const userPath = path.join(configDir, "user.json");
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword)
    return res.status(400).json({ error: "Both old and new password are required" });

  const user = JSON.parse(fs.readFileSync(userPath, "utf8"));
  const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
  if (!isMatch) return res.status(401).json({ error: "Old password is incorrect" });

  const hashed = await bcrypt.hash(newPassword, 12);
  user.password_hash = hashed;

  fs.writeFileSync(userPath, JSON.stringify(user, null, 2));
  res.json({ message: "Password updated successfully" });
});


const watchers = new Map();
function filterStatusLines(lines) {
  const keywords = ['stopped', 'error', 'cleaned', 'idle', 'done', 'starting', 'running'];
  return lines.filter(line => keywords.some(k => line.toLowerCase().includes(k)));
}

io.on("connection", (socket) => {
  // --- DASHBOARD: WORKER STATUS ---
  socket.on("watchWorker", (id) => {
    const logFile = path.join(baseLogDir, "worker-main.log");
    if (!fs.existsSync(logFile)) {
      socket.emit("workerStatus", { id, status: "no log file" });
      return;
    }

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const matchLines = lines.filter((l) => l.includes(`Worker ${id}`));
    const last = matchLines.at(-1);
    const status = last ? last.split(`Worker ${id}`)[1]?.trim() || "idle" : "idle";
    socket.emit("workerStatus", { id, status });

    const key = `workerStatus-${id}-${socket.id}`;
    if (!watchers.has(key)) {
      const watcher = fs.watch(logFile, (eventType) => {
        if (eventType === "change") {
          try {
            const content = fs.readFileSync(logFile, "utf8").trim().split("\n");
            const matchLines = content.filter((l) => l.includes(`Worker ${id}`));
            const last = matchLines.at(-1);
            const status = last ? last.split(`Worker ${id}`)[1]?.trim() || "idle" : "idle";
            socket.emit("workerStatus", { id, status });
          } catch (err) {
            console.error("⚠️ Error reading worker-main.log:", err);
          }
        }
      });
      watchers.set(key, watcher);
    }
  });

  // --- DASHBOARD: MAIN LOGS (DISARING) ---
  socket.on("watchLogs", () => {
    const logFile = path.join(baseLogDir, "worker-main.log");
    if (!fs.existsSync(logFile)) {
      socket.emit("mainLogs", { logs: ["no log file"] });
      return;
    }

    const content = fs.readFileSync(logFile, "utf8");
    const logs = filterStatusLines(content.split("\n").filter(Boolean)).slice(-300);
    socket.emit("mainLogs", { logs });

    const key = `mainLogs-${socket.id}`;
    if (!watchers.has(key)) {
      const watcher = fs.watch(logFile, (eventType) => {
        if (eventType === "change") {
          try {
            const content = fs.readFileSync(logFile, "utf8");
            const logs = filterStatusLines(content.split("\n").filter(Boolean)).slice(-300);
            socket.emit("mainLogs", { logs });
          } catch (err) {
            console.error("⚠️ Error reading main log:", err);
          }
        }
      });
      watchers.set(key, watcher);
    }
  });

  // --- DASHBOARD: CONFIG WORKER ---
  socket.on("watchWorkerConfig", (id) => {
    const configPath = path.join(configDir, `worker${id}`, "config.json");
    if (!fs.existsSync(configPath)) {
      socket.emit("workerConfig", { id, status: "no config file" });
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    socket.emit("workerConfig", { id, config });

    const key = `config-${id}-${socket.id}`;
    if (!watchers.has(key)) {
      const watcher = fs.watch(configPath, (eventType) => {
        if (eventType === "change") {
          try {
            const newConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
            socket.emit("workerConfig", { id, config: newConfig });
          } catch (err) {
            console.error(`⚠️ [${configPath}] Error reading config:`, err);
          }
        }
      });
      watchers.set(key, watcher);
    }
  });

  // --- DETAIL PAGE: LOGS PER WORKER ---
  socket.on("watchWorkerLogs", (id) => {
    const logFile = path.join(baseLogDir, `worker${id}.log`);
    if (!fs.existsSync(logFile)) {
      socket.emit("workerLogs", { logs: ["no log file"] });
      return;
    }

    const content = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    socket.emit("workerLogs", { logs: content.slice(-300) });

    const key = `workerLogs-${id}-${socket.id}`;
    if (!watchers.has(key)) {
      const watcher = fs.watch(logFile, (eventType) => {
        if (eventType === "change") {
          try {
            const content = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
            socket.emit("workerLogs", { logs: content.slice(-300) });
          } catch (err) {
            console.error(`⚠️ Error reading worker${id}.log:`, err);
          }
        }
      });
      watchers.set(key, watcher);
    }
  });

  socket.on("disconnect", () => {
    for (const [key, watcher] of watchers) {
      if (key.endsWith(socket.id)) {
        try {
          watcher.close?.();
        } catch { }
        watchers.delete(key);
      }
    }
  });
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

  const logFile = path.join(baseLogDir, `worker${nextId}.log`);
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, "");

  const configPath = path.join(configDir, `worker${nextId}`);
  if (!fs.existsSync(configPath)) fs.mkdirSync(configPath, { recursive: true });

  const config = {
    delayRandomStart: 240,
    delayRandomEnd: 300,
    note: "",
    isTableExist: false,
    qrLoggedIn: false,
    queue: 0
  };

  fs.writeFileSync(path.join(configPath, "config.json"), JSON.stringify(config, null, 2));
  logger.info(`☑ Worker ${nextId} idle`);
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
    const logFile = path.join(baseLogDir, `worker${id}.log`);
    const configPath = path.join(configDir, `worker${id}`);
    if (fs.existsSync(tableFile)) fs.unlinkSync(tableFile);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { recursive: true, force: true });
    logger.info(`✅ Worker ${id} idle`);
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
    // if (fs.existsSync(dir)) {
    //   for (const file of fs.readdirSync(dir)) {
    //     const filePath = path.join(dir, file);
    //     fs.rmSync(filePath, { recursive: true, force: true });
    //   }
    // }
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");
    updateConfig(id, { isTableExist: false, queue: 0 });
    logger.info(`✅ Worker ${id} idle`);
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

    updateConfig(id, { isTableExist: true, queue: getQueueSize(id) });
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
    const logs = (id === "-main") ? allLines.slice(-300) : allLines;

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

app.get("/api/workers/:id/table/get-private", async (req, res) => {
  const id = req.params.id;
  const tableFile = path.join(inputsDir, `worker${id}.xlsx`);

  if (!fs.existsSync(tableFile)) {
    return res.status(404).send("File not found");
  }

  try {
    const workbook = XLSX.readFile(tableFile);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const privateRows = rows.filter(r => String(r.status).toLowerCase() === "private");
    if (privateRows.length === 0) {
      return res.status(404).send("No rows with status 'Private'");
    }

    const lines = [];
    lines.push("========================================");
    privateRows.forEach((row, index) => {
      lines.push(`Contact Name   : ${row.member || "-"}`);
      lines.push(`Contact Phone  : ${row.phone || "-"}`);
      lines.push(`Group          : ${row.group || "-"}`);
      lines.push(`Status         : ${row.status || "-"}`);
      lines.push(`Timestamp      : ${row.timestamp || "-"}`);
      if (index < privateRows.length - 1) {
        lines.push("----------------------------------------");
      }
    });

    lines.push("========================================");
    const txtContent = lines.join("\n");
    const tempTxtPath = path.join(inputsDir, `worker${id}-private.txt`);
    fs.writeFileSync(tempTxtPath, txtContent, "utf8");
    res.download(tempTxtPath, `worker${id}-private.txt`, err => {
      if (err) console.error("Download error:", err);
      fs.unlink(tempTxtPath, () => { });
    });
  } catch (err) {
    res.status(500).send("Error processing Excel file");
  }
});

// View and edit config delay time
app.get("/workers/:id/config", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "edit.html"));
})

app.get("/api/workers/:id/config", (req, res) => {
  const id = req.params.id;
  const configPath = path.join(configDir, `worker${id}`, "config.json");

  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ success: false, message: "Config not found" });
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  res.json({ success: true, id, config });
});

// update config for a worker
app.post("/api/workers/:id/config", (req, res) => {
  const id = req.params.id;
  const configPath = path.join(configDir, `worker${id}`, "config.json");

  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ success: false, message: "Config not found" });
  }
  const newConfig = updateConfig(id, req.body);
  res.json({ success: true, id, newConfig });
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
  logger.info(`Service starting at http://localhost:${PORT}`);
});