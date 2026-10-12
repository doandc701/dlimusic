// Vercel function for /api/cloud/<action> (see cloud/api.js). Needs MONGODB_URI and TDL_SECRET
// (16+ characters) in the project's environment variables; without them the browser keeps its data locally.
import { createCloudApi, verifyWithTelegram } from "../../cloud/api.js";

const handle = createCloudApi({ env: process.env, verify: verifyWithTelegram });

export default function handler(req, res) {
  return handle(req, res, String(req.query?.action || ""));
}
