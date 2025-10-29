import fs from "fs";
import path from "path";
import { parentPort, workerData } from "worker_threads";
import { createLogger } from "./utils/logger.js";
import { puppeteerBot } from "./puppeteer.js";
import XLSX from "xlsx";

const inputsDir = "/data/inputs";
const id = workerData.id;

const logger = createLogger(id);
const tablePath = path.join(inputsDir, `worker${id}.xlsx`);
const DELAY_HOURS = Number(process.env.DELAY_HOURS || 2);
const DELAY_MS = DELAY_HOURS * 60 * 60 * 1000;

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
    logger.info(`[worker${id}] ✅ Updated member ${current.member} => ${message}`);
  } else {
    logger.warn(`[worker${id}] ⚠️ Member ${current.member} not found in table`);
  }
}

function getNextPending() {
  const { rows } = readTable();
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
    break;
  }
}

parentPort.postMessage({ id, done: true });
