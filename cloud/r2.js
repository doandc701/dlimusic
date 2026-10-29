// Cloudflare R2 (S3 API) without an SDK, for the songs of shared playlists: requests signed with AWS Signature V4
// (query string), sent from the server only — browsers never reach R2 (some networks block it). Node only.
//
// Settings (Vercel environment variables):
//   R2_ACCOUNT_ID         Cloudflare account id (the <id>.r2.cloudflarestorage.com endpoint)
//   R2_ACCESS_KEY_ID      R2 API token: Access Key ID   (Object Read & Write on the bucket)
//   R2_SECRET_ACCESS_KEY  R2 API token: Secret Access Key
//   R2_BUCKET             bucket name

import crypto from "node:crypto";

const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
// RFC 3986: encodeURIComponent leaves !'()* alone, S3 wants them escaped
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A presigned URL (only the host header signed, payload unsigned).
 * @param path     "/bucket/key" (each segment is encoded here)
 * @param query    extra query parameters, signed too (e.g. response-content-type)
 * @param now      Date of signing (tests)
 */
export function presign({
  method,
  host,
  path,
  region,
  accessKeyId,
  secretAccessKey,
  expires,
  query = {},
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const params = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
  const uri = path.split("/").map(enc).join("/");
  const canonical = [method, uri, qs, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = ["s3", "aws4_request"].reduce(hmac, hmac(hmac(`AWS4${secretAccessKey}`, day), region));
  return `https://${host}${uri}?${qs}&X-Amz-Signature=${hmac(key, toSign).toString("hex")}`;
}

/** The R2 settings from the environment, or null when one is missing. */
export function r2Config(env) {
  const c = {
    account: String(env.R2_ACCOUNT_ID || "").trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || "").trim(),
    bucket: String(env.R2_BUCKET || "").trim(),
  };
  if (!/^[0-9a-f]{32}$/i.test(c.account) || !c.accessKeyId || !c.secretAccessKey || !/^[a-z0-9-]{3,63}$/.test(c.bucket))
    return null;
  return c;
}

/**
 * One bucket: put, read (a byte range), remove.
 * @param fetchFn  fetch (injected in tests)
 */
export function createBucket(config, { fetchFn = (...a) => fetch(...a), now = () => new Date() } = {}) {
  const sign = (method, key, expires, query) =>
    presign({
      method,
      host: `${config.account}.r2.cloudflarestorage.com`,
      path: key ? `/${config.bucket}/${key}` : `/${config.bucket}`, // "": the bucket itself
      region: "auto",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expires,
      query,
      now: now(),
    });
  return {
    async put(key, body, type) {
      const res = await fetchFn(sign("PUT", key, 300), { method: "PUT", body, headers: { "Content-Type": type } });
      if (!res.ok) throw new Error(`R2 PUT ${res.status}`);
    },
    /** Bytes [start, end] of an object, as a stream (passed on as they come); null when it is not there. */
    async stream(key, start, end) {
      const res = await fetchFn(sign("GET", key, 300), { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${res.status}`);
      return res.body;
    },
    /** Remove many objects at once (DeleteObjects, up to 1000 keys a request); missing ones are fine. */
    async removeMany(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const xml =
          "<Delete><Quiet>true</Quiet>" +
          keys
            .slice(i, i + 1000)
            .map((k) => `<Object><Key>${k.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Key></Object>`)
            .join("") +
          "</Delete>";
        const res = await fetchFn(sign("POST", "", 300, { delete: "" }), {
          method: "POST",
          body: xml,
          headers: {
            "Content-Type": "application/xml",
            "Content-MD5": crypto.createHash("md5").update(xml).digest("base64"),
          },
        });
        if (!res.ok) throw new Error(`R2 DeleteObjects ${res.status}`);
      }
    },
  };
}
