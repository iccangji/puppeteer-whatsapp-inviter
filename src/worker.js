import fs from "fs";
import path from "path";
import { parentPort, workerData } from "worker_threads";
import { createLogger } from "./utils/logger.js";
import { puppeteerBot } from "./puppeteer.js";

const inputsDir = "/data/inputs";
const id = workerData.id;

const logger = createLogger(id);
const csvPath = path.join(inputsDir, `worker${id}.csv`);
const DELAY_HOURS = Number(process.env.DELAY_HOURS || 2);
const DELAY_MS = DELAY_HOURS * 60 * 60 * 1000;

function readCSV() {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, "member,status,timestamp\n");
  }
  const content = fs.readFileSync(csvPath, "utf8").trim();
  const lines = content.split("\n");
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h, i) => (obj[h.trim()] = values[i]?.trim()));
    return obj;
  });
  return { headers, rows };
}

function writeCSV(headers, rows) {
  const lines = [headers.join(",")];
  rows.forEach(r => {
    lines.push(headers.map(h => r[h] ?? "").join(","));
  });
  fs.writeFileSync(csvPath, lines.join("\n"));
}

function updateRow(current, message) {
  const { headers, rows } = readCSV();
  const timestamp = new Date()
    .toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    .replace(",", "");
  const idx = rows.findIndex(r => r.member === current.member);
  if (idx !== -1) {
    rows[idx] = { ...rows[idx], ...current, status: message, timestamp };
  }
  writeCSV(headers, rows);
  logger.info(`[worker${id}] ✅ Updated member ${current.member} => ${message}`);
}

function getNextPending() {
  const { rows } = readCSV();
  return rows.find(r => (!r.status || r.status === "") && (!r.timestamp || r.timestamp === "")) || null;
}

while (true) {
  try {
    const current = getNextPending();
    if (!current) {
      logger.info(`[worker${id}] No pending contacts. Worker OFF`);
      break;
    }
    logger.info(`[worker${id}] Processing ${current.member} (${current.phone})`);
    try {
      const { success, message } = await puppeteerBot(id, current);
      if (success) {
        updateRow({ member: current.member }, message);
      } else {
        logger.error(message)
        parentPort.postMessage({ id, done: false });
        break;
      }
    } catch (err) {
      logger.error(err);
      parentPort.postMessage({ id, done: false });
      break;
    }
    logger.info(`[worker${id}] ⏳ Delay ${DELAY_HOURS} hours before next`);
    await new Promise(r => setTimeout(r, DELAY_MS));
  } catch (err) {
    logger.error(err);
    parentPort.postMessage({ id, done: false });
  }
}

parentPort.postMessage({ id, done: true });
