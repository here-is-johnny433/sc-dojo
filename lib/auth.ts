// Auth: bcrypt-verified login issues an HMAC-signed, expiring session cookie
// carrying the user id and role. Web Crypto only and no pg import, so
// verification also runs in middleware (edge runtime) — anything that needs the
// database lives in lib/session.ts instead.

export type Role = "admin" | "player";

export interface SessionPayload {
  userId: number;
  role: Role;
  exp: number;
}

const SESSION_COOKIE = "dojo_session";
const SESSION_DAYS = 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("base64url");
}

export async function createSessionToken(userId: number, role: Role): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${userId}.${role}.${exp}.${await hmac(`session:${userId}:${role}:${exp}`)}`;
}

export async function verifySessionToken(
  token: string | undefined
): Promise<SessionPayload | null> {
  if (!token) return null;
  const [idStr, role, expStr, sig] = token.split(".");
  const userId = Number(idStr);
  const exp = Number(expStr);
  if (!sig || !Number.isInteger(userId) || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (role !== "admin" && role !== "player") return null;
  const expected = await hmac(`session:${userId}:${role}:${exp}`);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { userId, role, exp } : null;
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

export function validUploadToken(header: string | null): boolean {
  const expected = process.env.UPLOAD_TOKEN;
  if (!expected || !header || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// -- login rate limit (per IP + email, in-memory; single-instance app) --
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function attemptKey(ip: string, email: string): string {
  return `${ip}:${email.toLowerCase()}`;
}

export function loginRateLimited(ip: string, email: string): boolean {
  const now = Date.now();
  const entry = attempts.get(attemptKey(ip, email));
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string, email: string): void {
  const now = Date.now();
  const key = attemptKey(ip, email);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export function clearLoginFailures(ip: string, email: string): void {
  attempts.delete(attemptKey(ip, email));
}
