// DLiMusic app config (on top of app.json). Values from, in this order: the environment (EAS Build: its project
// variables), this app's .env (template: .env.example), the web version's ../.env — API_ID / API_HASH (Telegram,
// the same as the web's), CLOUD_URL (the sync server). The .env files are never committed.
const fs = require("fs");
const path = require("path");

function readEnv(file) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
    );
  } catch {
    return {};
  }
}

module.exports = ({ config }) => {
  const files = { ...readEnv(path.join(__dirname, "..", ".env")), ...readEnv(path.join(__dirname, ".env")) };
  const get = (name) => process.env[name] || files[name] || "";
  return {
    ...config,
    extra: {
      ...config.extra,
      tgApiId: Number(get("API_ID") || process.env.TG_API_ID) || 0,
      tgApiHash: get("API_HASH") || process.env.TG_API_HASH || "",
      cloudUrl: (get("CLOUD_URL") || "https://dlimusic.vercel.app").replace(/\/+$/, ""),
    },
  };
};
