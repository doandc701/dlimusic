// What GramJS (written for Node and browsers) expects from its surroundings, for React Native.
// Imported first, before anything that loads GramJS.
import { Buffer } from "buffer";
import { getRandomValues } from "expo-crypto";
import { sha1 } from "@noble/hashes/legacy.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import process from "process";

const g = globalThis as any;
g.Buffer ??= Buffer;
g.process = { ...process, ...g.process, env: { ...process.env, ...g.process?.env } };
g.self ??= g;
// GramJS reads window.location.protocol to pick secure WebSockets: always wss://
g.window ??= g;
g.window.location ??= { protocol: "https:", href: "https://app.dlimusic/", host: "app.dlimusic" };
// GramJS' WebSocket listens for the browser's "offline" event; React Native has no such events on window
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};

// WebCrypto: the three things GramJS' browser crypto uses (random bytes, SHA-1/256 digests, PBKDF2-SHA512 for
// the two-step password). Pure-JS hashes from @noble/hashes, random bytes from the system (expo-crypto).
const bytes = (d: ArrayBuffer | ArrayBufferView) =>
  d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
const out = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
type Hash = typeof sha1; // all three share the shape @noble/hashes' pbkdf2 takes
const HASH: Record<string, Hash> = { "SHA-1": sha1, "SHA-256": sha256 as Hash, "SHA-512": sha512 as Hash };
const name = (a: string | { name: string }) => (typeof a === "string" ? a : a.name).toUpperCase();

const subtle = {
  async digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView) {
    const hash = HASH[name(algorithm)];
    if (!hash) throw new Error(`digest: ${name(algorithm)} not supported`);
    return out(hash(bytes(data)));
  },
  async importKey(_format: "raw", key: ArrayBuffer | ArrayBufferView) {
    return { raw: bytes(key) };
  },
  async deriveBits(
    params: { name: string; hash: string | { name: string }; salt: ArrayBuffer | ArrayBufferView; iterations: number },
    key: { raw: Uint8Array },
    length: number,
  ) {
    const hash = HASH[name(params.hash)];
    if (name(params.name) !== "PBKDF2" || !hash) throw new Error("deriveBits: only PBKDF2");
    return out(pbkdf2(hash, key.raw, bytes(params.salt), { c: params.iterations, dkLen: length / 8 }));
  },
};

g.crypto ??= {};
g.crypto.getRandomValues ??= getRandomValues;
g.crypto.subtle ??= subtle;
