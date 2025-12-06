// orderLogger.js
import fs from "fs";
import path from "path";

const logFile = path.join(process.cwd(), "order_logs.jsonl");

/**
 * Append a single log entry as JSON per line (JSONL).
 * This never overwrites, only appends.
 */
export async function logOrderEvent(eventData) {
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    ...eventData,
  };

  const line = JSON.stringify(entry) + "\n";

  try {
    await fs.promises.appendFile(logFile, line);
  } catch (err) {
    console.error("Failed to write order log:", err);
  }
}

/**
 * Read all logs back as an array.
 * You can use this in an admin route later.
 */
export async function getAllOrderLogs() {
  try {
    const raw = await fs.promises.readFile(logFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return []; // file not created yet
    console.error("Failed to read order logs:", err);
    return [];
  }
}
