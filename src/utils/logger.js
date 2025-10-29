import winston from "winston";
import fs from "fs";
import path from "path";

const baseLogDir = "/data/logs";

// pastikan folder log ada
if (!fs.existsSync(baseLogDir)) fs.mkdirSync(baseLogDir, { recursive: true });

/**
 * Membuat logger per worker
 * @param {string|number} workerId - ID Worker (contoh: 1, 2, "server")
 * @returns {winston.Logger}
 */
export function createLogger(workerId = "-main") {
    const filename = path.join(baseLogDir, `worker${workerId}.log`);

    const logger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
            winston.format.timestamp({ format: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) }),
            winston.format.printf(({ level, message, timestamp }) => {
                return `[${timestamp}] [worker${workerId}] ${level.toUpperCase()}: ${message}`;
            })
        ),
        transports: [
            new winston.transports.File({ filename }),
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({ level, message, timestamp }) => {
                        return `[${timestamp}] [worker${workerId}] ${level}: ${message}`;
                    })
                ),
            }),
        ],
    });

    return logger;
}

// Default logger (untuk server utama)
const logger = createLogger("-main");

export default logger;
