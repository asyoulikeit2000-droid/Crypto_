import { S3Client, HeadBucketCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const endpoint = process.env.R2_ENDPOINT || "";
const bucket = process.env.R2_BUCKET || "";
const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";

export function r2Configured() {
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

export function createR2Archive() {
  if (!r2Configured()) throw new Error("R2 credentials not configured");
  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey }
  });

  return {
    client,
    bucket,
    async healthcheck() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    },
    async putJsonlGzip({ dataset, rows, periodStart, periodEnd, symbol = "all" }) {
      if (!Array.isArray(rows) || !rows.length) return null;
      const jsonl = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      const body = gzipSync(Buffer.from(jsonl));
      const checksum = createHash("sha256").update(body).digest("hex");
      const day = String(periodStart || new Date().toISOString()).slice(0,10).replaceAll("-","/");
      const stamp = new Date().toISOString().replaceAll(":","-");
      const key = `${dataset}/${symbol}/${day}/${stamp}.jsonl.gz`;
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-ndjson",
        ContentEncoding: "gzip",
        Metadata: {
          dataset,
          rows: String(rows.length),
          checksum,
          period_start: String(periodStart || ""),
          period_end: String(periodEnd || "")
        }
      }));
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { objectKey: key, rowCount: rows.length, checksum, archivedAt: new Date().toISOString() };
    }
  };
}
