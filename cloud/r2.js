// Cloudflare R2 (S3 API) without an SDK: presigned URLs (AWS Signature V4, query string) for the songs of
// shared playlists. The browser uploads with a PUT URL, the listener plays with a GET URL; the server only
// signs, checks (HEAD) and removes (DELETE). Node only.
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
 * One bucket: signed URLs, plus HEAD / DELETE done from here.
 * @param fetchFn  fetch (injected in tests)
 */
export function createBucket(config, { fetchFn = (...a) => fetch(...a), now = () => new Date() } = {}) {
  const sign = (method, key, expires, query) =>
    presign({
      method,
      host: `${config.account}.r2.cloudflarestorage.com`,
      path: `/${config.bucket}/${key}`,
      region: "auto",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expires,
      query,
      now: now(),
    });
  return {
    putUrl: (key, expires) => sign("PUT", key, expires),
    getUrl: (key, expires, query) => sign("GET", key, expires, query),
    /** Size of a stored object, or null when it is not there. */
    async size(key) {
      const res = await fetchFn(sign("HEAD", key, 60), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 HEAD ${res.status}`);
      return Number(res.headers.get("content-length")) || 0;
    },
    async remove(key) {
      const res = await fetchFn(sign("DELETE", key, 60), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${res.status}`);
    },
  };
}
