import fs from "fs";
import path from "path";
import { parentPort, workerData } from "worker_threads";
import { createLogger } from "./utils/logger.js";
import { puppeteerBot } from "./puppeteer.js";
import { updateConfig, getQueueSize } from "./utils/config.js";
import XLSX from "xlsx";

const id = workerData.id;
const logger = createLogger(id);
const inputsDir = "/data/inputs";
const profilesDir = "/data/profiles";
const configDir = "/data/config";
const tablePath = path.join(inputsDir, `worker${id}.xlsx`);


function readTable() {
  if (!fs.existsSync(tablePath)) {
    const ws = XLSX.utils.json_to_sheet([]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, tablePath);
  }

  const workbook = XLSX.readFile(tablePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headers = Object.keys(rows[0] || { member: "", status: "", timestamp: "" });
  return { headers, rows };
}

function writeTable(headers, rows) {
  const normalized = rows.map(row => {
    const obj = {};
    headers.forEach(h => (obj[h] = row[h] ?? ""));
    return obj;
  });

  const ws = XLSX.utils.json_to_sheet(normalized);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, tablePath);
}

export function updateRow(current, message) {
  const { headers, rows } = readTable();
  const timestamp = new Date()
    .toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    .replace(",", "");

  const idx = rows.findIndex(r => r.member === current.member);
  if (idx !== -1) {
    rows[idx] = { ...rows[idx], ...current, status: message, timestamp };
    writeTable(headers, rows);
    logger.info(`✅ Updated member ${current.member} => ${message}`);
  } else {
    logger.warn(`⚠️ Member ${current.member} not found in table`);
  }
}

function getDelayMinutes() {
  const configPath = path.join(configDir, `worker${id}`, "config.json");
  if (!fs.existsSync(configPath)) {
    logger.info(`No delay config. Delay default: 120 minutes`);
    return 120; // Default delay minutes
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const delay = Math.floor(Math.random() * (config.delayRandomEnd - config.delayRandomStart + 1)) + config.delayRandomStart;

  return delay;
}

function getNextPending() {
  const { rows } = readTable();
  return rows.find(r => (!r.status || r.status === "") && (!r.timestamp || r.timestamp === "")) || null;
}

while (true) {
  try {
    const current = getNextPending();
    if (!current) {
      const result = `No pending contacts. Worker OFF`;
      logger.info(result);
      parentPort.postMessage({ id, done: true, message: result });
      break;
    }
    logger.info(`Processing ${current.member} (${current.phone})`);
    try {
      const { success, message } = await puppeteerBot(id, current);
      if (success) {
        updateRow({ member: current.member }, message);
        updateConfig(id, { queue: getQueueSize(id) });
        const next = getNextPending();
        if (!next) {
          const result = `No next contacts. Worker OFF`;
          logger.info(result);
          parentPort.postMessage({ id, done: true, message: result });
          break;
        }
      } else {
        logger.error(message)
        parentPort.postMessage({ id, done: false, message });
        updateConfig(id, { qrLoggedIn: false });
        break;
      }
    } catch (err) {
      logger.error(err);
      parentPort.postMessage({ id, done: false, message: err });
      break;
    }


    const delayMinutes = getDelayMinutes();
    logger.info(`⏳ Delay ${delayMinutes} minutes before next member`);
    await new Promise(r => setTimeout(r, delayMinutes * 60 * 1000));

  } catch (err) {
    logger.error(err);
    parentPort.postMessage({ id, done: false, message: err });
    break;
  }
}