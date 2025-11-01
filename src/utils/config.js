import fs from "fs";
import path from "path";
import XLSX from "xlsx";

const configDir = "/data/config";
const inputsDir = "/data/inputs";

export function updateConfig(id, config) {
    const configPath = path.join(configDir, `worker${id}`, "config.json");
    if (!fs.existsSync(configPath)) return;
    const oldConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const newConfig = { ...oldConfig, ...config };
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    return newConfig;
}

export function getQueueSize(id) {
    const tablePath = path.join(inputsDir, `worker${id}.xlsx`);
    if (!fs.existsSync(tablePath)) return 0;
    const workbook = XLSX.readFile(tablePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const queueSize = rows.filter(r => !r.status && !r.timestamp).length;
    return queueSize;
}