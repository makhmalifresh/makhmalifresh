// orderLogger.js — Cloudflare R2 (Option A: Fully Remote JSONL Logging)

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

import dotenv from "dotenv";
dotenv.config();

// --------------------------
//  R2 CONFIG
// --------------------------
const R2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  }
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const LOG_KEY = "order-logs/order_logs.jsonl"; // folder inside R2 bucket

// Helper to stream R2 object into string
async function streamToString(stream) {
  return await new Promise((resolve, reject) => {
    let chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

// --------------------------
//  APPEND ORDER EVENT
// --------------------------
export async function logOrderEvent(eventData) {
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    ...eventData,
  };

  const newLine = JSON.stringify(entry) + "\n";

  try {
    // 1️⃣ Get existing logs (if any)
    let existing = "";
    try {
      const data = await R2.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: LOG_KEY,
        })
      );

      existing = await streamToString(data.Body);
    } catch (err) {
      if (err.$metadata?.httpStatusCode !== 404) {
        console.error("❌ Failed to read existing logs:", err);
      }
      // If 404 → first log file, ignore
    }

    // 2️⃣ Append new event
    const updated = existing + newLine;

    // 3️⃣ Write back to R2
    await R2.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: LOG_KEY,
        Body: updated,
        ContentType: "application/jsonl",
      })
    );

    // console.log("📄 Log saved to R2:", eventData.event);
  } catch (err) {
    console.error("❌ Failed to write log to R2:", err);
  }
}

// --------------------------
//  READ ALL ORDER LOGS
// --------------------------
export async function getAllOrderLogs() {
  try {
    const data = await R2.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: LOG_KEY,
      })
    );

    const raw = await streamToString(data.Body);

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
    if (err.$metadata?.httpStatusCode === 404) {
      return []; // no logs yet
    }

    console.error("❌ Failed to read logs:", err);
    return [];
  }
}
