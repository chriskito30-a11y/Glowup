import { db, ref, set, update, get, onValue, query, orderByChild, equalTo, push, remove } from "./firebase-config.js";

export const MODULE_ID = "glowup";
export const DATA_ROOT = `moduleData/${MODULE_ID}/sessions`;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function slugify(value = "show") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34) || "show";
}

export function randomId(prefix = "glow") {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
}

export function sessionUrl(sessionId) {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}join.html?session=${encodeURIComponent(sessionId)}`;
}

export function qrUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(value)}`;
}

export function colorName(hex) {
  const map = {"#ffffff":"Blanc","#ff2d55":"Rose","#7c3aed":"Violet","#22d3ee":"Bleu","#22c55e":"Vert","#facc15":"Jaune","#f97316":"Orange","#ef4444":"Rouge"};
  return map[String(hex).toLowerCase()] || hex;
}

export function currentEffectPayload(type, options = {}) {
  return {
    id: randomId("effect"),
    type,
    color: options.color || "#ffffff",
    zone: options.zone || "all",
    durationMs: Number(options.durationMs || 9000),
    startedAt: Date.now(),
    label: options.label || type
  };
}

export async function createSession({ user, access, title, subtitle, eventDate, warningAccepted }) {
  if (!user) throw new Error("Connexion requise.");
  const limits = access?.limits || { eventsPerPeriod: 1, participantsPerEvent: 30, quotaPeriod: "month" };
  const billingPeriod = access?.billingPeriod;
  if (!billingPeriod) throw new Error("Période de quota indisponible.");

  const usagePath = `usage/${user.uid}/${billingPeriod}/${MODULE_ID}`;
  const usageSnap = await get(ref(db, `${usagePath}/eventsCreated`));
  const used = Number(usageSnap.val() || 0);
  const max = Number(limits.eventsPerPeriod || 1);
  if (!access?.unlimited && used >= max) {
    const err = new Error("Limite de l’offre atteinte.");
    err.code = "modulys/free-limit-reached";
    err.limits = limits;
    err.period = billingPeriod;
    err.offerName = access?.plan?.name || access?.planId || "Gratuit";
    throw err;
  }

  const cleanTitle = title || "Show lumineux GlowUp";
  const sessionId = `${slugify(cleanTitle)}-${randomId("").replace(/^-/, "")}`;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const sessionPlanId = access?.unlimited ? "lifetime" : (access?.planId || "free");
  const session = {
    id: sessionId,
    ownerUid: user.uid,
    ownerEmail: user.email || "",
    moduleId: MODULE_ID,
    planId: sessionPlanId,
    billingPeriod,
    title: cleanTitle,
    subtitle: subtitle || "Le public devient la lumière du spectacle.",
    eventDate: eventDate || "",
    createdAt: now,
    updatedAt: now,
    expiresAt,
    participantsLimit: Number(limits.participantsPerEvent || 30),
    warningAccepted: Boolean(warningAccepted),
    status: "open",
    zones: { left: "Gauche", center: "Centre", right: "Droite" },
    stats: { participantsCount: 0 },
    currentEffect: { id: "idle", type: "idle", color: "#111827", zone: "all", durationMs: 0, startedAt: now, label: "Repos" }
  };

  await update(ref(db), {
    [`${DATA_ROOT}/${sessionId}`]: session,
    [`${usagePath}/eventsCreated`]: used + 1,
    [`${usagePath}/entities/${sessionId}`]: true,
    [`${usagePath}/updatedAt`]: now
  });
  return { sessionId, session };
}

export async function listOwnerSessions(user) {
  const ownerSessions = query(ref(db, DATA_ROOT), orderByChild("ownerUid"), equalTo(user.uid));
  const snap = await get(ownerSessions);
  return Object.entries(snap.val() || {}).sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));
}

export async function readSession(sessionId) {
  const snap = await get(ref(db, `${DATA_ROOT}/${sessionId}`));
  return snap.val();
}

export function listenSession(sessionId, callback) {
  return onValue(ref(db, `${DATA_ROOT}/${sessionId}`), snap => callback(snap.val()));
}

export async function launchEffect(sessionId, payload) {
  await update(ref(db, `${DATA_ROOT}/${sessionId}`), { currentEffect: payload, updatedAt: Date.now() });
}

export async function closeSession(sessionId) {
  await update(ref(db, `${DATA_ROOT}/${sessionId}`), { status: "closed", updatedAt: Date.now(), currentEffect: currentEffectPayload("idle", { color: "#111827", label: "Session fermée" }) });
}

export async function joinSession(sessionId, { name, zone }) {
  const session = await readSession(sessionId);
  if (!session || session.expiresAt <= Date.now() || session.status === "closed") throw new Error("Session GlowUp expirée ou indisponible.");
  const participants = session.participants || {};
  const limit = Number(session.participantsLimit || 30);
  if (Object.keys(participants).length >= limit) throw new Error("La limite de participants est atteinte pour cette session.");
  let participantId = localStorage.getItem(`glowup:${sessionId}:participantId`);
  if (!participantId) {
    participantId = randomId("p");
    localStorage.setItem(`glowup:${sessionId}:participantId`, participantId);
  }
  const now = Date.now();
  await set(ref(db, `${DATA_ROOT}/${sessionId}/participants/${participantId}`), {
    id: participantId,
    name: String(name || "Participant").slice(0, 40),
    zone: ["left", "center", "right"].includes(zone) ? zone : "center",
    joinedAt: now,
    lastSeenAt: now
  });
  return { participantId };
}

export function startHeartbeat(sessionId, participantId) {
  const tick = () => update(ref(db, `${DATA_ROOT}/${sessionId}/participants/${participantId}`), { lastSeenAt: Date.now() }).catch(() => {});
  tick();
  return window.setInterval(tick, 15000);
}
