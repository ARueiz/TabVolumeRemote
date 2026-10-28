import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadConfig(env = process.env, file = new URL("../.env", import.meta.url), interfaces = networkInterfaces()) {
  let settings = {};
  try {
    let source = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (source.split(/\r?\n/).some(line => /^(?:export\s+)?TVR_/.test(line.trim()) && !/^(?:export\s+)?TVR_[A-Z0-9_]+\s*=/.test(line.trim()))) {
      throw new Error("INVALID_ENV_LINE");
    }
    settings = parseEnv(source);
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("無法讀取或解析專案根目錄 .env，請檢查檔案格式與讀取權限。");
  }
  let known = ["TVR_HOST", "TVR_PORT", "TVR_PAIRING_TOKEN", "TVR_EXTENSION_TOKEN", "TVR_EXTENSION_ID", "TVR_EXTENSION_IDS", "TVR_SESSION_SECONDS", "TVR_PAIR_MAX_FAILURES", "TVR_PAIR_WINDOW_SECONDS"];
  if (Object.keys(settings).some(key => key.startsWith("TVR_") && !known.includes(key))) {
    throw new Error(".env 含有未知的 TVR_ 設定名稱，請比對 .env.example。");
  }
  // Do not mutate process.env or apply unrelated settings such as NODE_OPTIONS.
  let overrides = Object.fromEntries(Object.entries(env).map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]));
  return readConfig({ ...settings, ...overrides }, interfaces);
}

export function isPrivateIPv4(address) {
  if (!isIPv4(address)) return false;
  let [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function integerSetting(env, name, fallback, min, max) {
  let raw = env[name] ?? String(fallback);
  let value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必須是 ${min}～${max} 的整數。`);
  }
  return value;
}

export function readConfig(env = process.env, interfaces = networkInterfaces()) {
  let host = env.TVR_HOST;
  if (!isPrivateIPv4(host)) {
    throw new Error("請以 TVR_HOST 明確指定 RFC1918 私人 IPv4；不可使用萬用位址、公網 IP 或主機名稱。");
  }
  if (!Object.values(interfaces).flat().some(item => item.family === "IPv4" && !item.internal && item.address === host)) {
    throw new Error("TVR_HOST 必須是本機已配置的私人 IPv4 介面。");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(env.TVR_PAIRING_TOKEN || "")) {
    throw new Error("TVR_PAIRING_TOKEN 必須使用 32 個隨機位元組的 base64url 格式（43 字元）。");
  }
  let extensionHash = null;
  if (env.TVR_EXTENSION_ID && env.TVR_EXTENSION_IDS) throw new Error("TVR_EXTENSION_ID 與 TVR_EXTENSION_IDS 請擇一設定。");
  let extensionIds = (env.TVR_EXTENSION_IDS || env.TVR_EXTENSION_ID || "").split(",").map(id => id.trim()).filter(Boolean);
  if (env.TVR_EXTENSION_TOKEN || env.TVR_EXTENSION_ID || env.TVR_EXTENSION_IDS) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(env.TVR_EXTENSION_TOKEN || "") || !extensionIds.length || extensionIds.length > 8
        || extensionIds.some(id => !/^[a-p]{32}$/.test(id)) || new Set(extensionIds).size !== extensionIds.length
        || (env.TVR_EXTENSION_IDS && env.TVR_EXTENSION_IDS.split(",").some(id => !id.trim()))) {
      throw new Error("請設定隨機 TVR_EXTENSION_TOKEN 及有效的 TVR_EXTENSION_ID，或最多 8 個不重複、逗號分隔的 TVR_EXTENSION_IDS（各 32 字元）。");
    }
    if (env.TVR_EXTENSION_TOKEN === env.TVR_PAIRING_TOKEN) throw new Error("擴充功能與手機必須使用不同 Token。");
    extensionHash = createHash("sha256").update(env.TVR_EXTENSION_TOKEN).digest();
  }
  return {
    host,
    port: integerSetting(env, "TVR_PORT", 3210, 1, 65535),
    pairingHash: createHash("sha256").update(env.TVR_PAIRING_TOKEN).digest(),
    extensionHash,
    extensionId: env.TVR_EXTENSION_ID || null,
    extensionIds,
    sessionSeconds: integerSetting(env, "TVR_SESSION_SECONDS", 28800, 60, 86400),
    pairMaxFailures: integerSetting(env, "TVR_PAIR_MAX_FAILURES", 5, 1, 10),
    pairWindowSeconds: integerSetting(env, "TVR_PAIR_WINDOW_SECONDS", 300, 30, 3600)
  };
}
