import winston from "winston";
import fs from "fs";
import path from "path";

const baseLogDir = "/data/logs";
if (!fs.existsSync(baseLogDir)) fs.mkdirSync(baseLogDir, { recursive: true });

const LOG_PATH = path.join(baseLogDir, "worker-main.log");
const MAX_AGE_DAYS = 7;

function pruneOldLogs() {
    if (!fs.existsSync(LOG_PATH)) return;
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    try {
        const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
        const filtered = lines.filter(line => {
            const match = line.match(/\[(\d{2}):(\d{2}):(\d{4}) (\d{2}):(\d{2}):(\d{2})\]/);
            if (!match) return true;

            const [_, d, m, y, h, min, s] = match;
            const ts = new Date(`${y}-${m}-${d}T${h}:${min}:${s}+07:00`);

            return ts.getTime() >= cutoff;
        });

        fs.writeFileSync(LOG_PATH, filtered.join("\n"));
    } catch (err) {
        console.error("[logger] Failed clear old logs:", err);
    }
}

export function createLogger(workerId = "-main") {
    const baseName = `worker${workerId}`;
    const logPath = path.join(baseLogDir, `${baseName}.log`);
    if (workerId == "-main") pruneOldLogs()
    return winston.createLogger({
        level: "info",
        format: winston.format.combine(
            winston.format.timestamp({
                format: () => {
                    const now = new Date();
                    const timeNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
                    const day = String(timeNow.getDate()).padStart(2, "0");
                    const month = String(timeNow.getMonth() + 1).padStart(2, "0");
                    const year = timeNow.getFullYear();
                    const hour = String(timeNow.getHours()).padStart(2, "0");
                    const minute = String(timeNow.getMinutes()).padStart(2, "0");
                    const second = String(timeNow.getSeconds()).padStart(2, "0");

                    return `${day}:${month}:${year} ${hour}:${minute}:${second}`;
                },
            }),
            winston.format.printf(({ level, message, timestamp }) => {
                return `[${timestamp}] [${baseName}] ${level.toUpperCase()}: ${message}`;
            })
        ),
        transports: [
            new winston.transports.File({ filename: logPath }),
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({ level, message, timestamp }) => {
                        return `[${timestamp}] [${baseName}] ${level}: ${message}`;
                    })
                ),
            }),
        ],
    });
}
// Default logger
const logger = createLogger("-main");

export default logger;
