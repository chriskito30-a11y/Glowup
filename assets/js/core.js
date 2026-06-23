import { db, ref, set, update, get, onValue, query, orderByChild, equalTo } from "./firebase-config.js";

export const MODULE_ID = "glowup";
export const DATA_ROOT = `moduleData/${MODULE_ID}/sessions`;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const ZONE_LABELS = { left: "Gauche", center: "Centre", right: "Droite" };
export const DEPTH_LABELS = { front: "Devant", middle: "Milieu", back: "Derrière" };

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function slugify(value = "show") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34) || "show";
}

export function randomId(prefix = "glow") {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}-${body}` : body;
}

export function sessionUrl(sessionId) {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}join.html?session=${encodeURIComponent(sessionId)}`;
}

export function qrUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(value)}`;
}

export function colorName(hex) {
  const map = {
    "#ffffff": "Blanc",
    "#ff2d55": "Rose",
    "#7c3aed": "Violet",
    "#22d3ee": "Bleu",
    "#22c55e": "Vert",
    "#facc15": "Jaune",
    "#f97316": "Orange",
    "#ef4444": "Rouge"
  };
  return map[String(hex).toLowerCase()] || hex;
}

export function normalizePlacementConfig(value = {}) {
  const rowCount = Math.max(0, Math.min(80, Number(value.rowCount || 0)));
  return {
    lateralEnabled: value.lateralEnabled !== false,
    depthEnabled: value.depthEnabled !== false,
    rowsEnabled: Boolean(value.rowsEnabled),
    rowCount
  };
}

export function normalizeTarget(target = {}) {
  return {
    zone: ["all", "left", "center", "right"].includes(target.zone) ? target.zone : "all",
    depth: ["all", "front", "middle", "back"].includes(target.depth) ? target.depth : "all",
    row: target.row && String(target.row) !== "0" ? String(target.row) : "all"
  };
}

export function targetLabel(target = {}) {
  const t = normalizeTarget(target);
  const parts = [];
  if (t.zone !== "all") parts.push(ZONE_LABELS[t.zone] || t.zone);
  if (t.depth !== "all") parts.push(DEPTH_LABELS[t.depth] || t.depth);
  if (t.row !== "all") parts.push(`Rangée ${t.row}`);
  return parts.length ? parts.join(" · ") : "Toute la salle";
}

export function currentEffectPayload(type, options = {}) {
  const target = normalizeTarget(options.target || { zone: options.zone || "all" });
  return {
    id: randomId("effect"),
    type,
    color: options.color || "#ffffff",
    zone: target.zone,
    target,
    durationMs: Number(options.durationMs || 9000),
    startedAt: Date.now(),
    label: options.label || type
  };
}

export async function createSession({
  user,
  access,
  title,
  subtitle,
  eventDate,
  warningAccepted,
  depthEnabled = true,
  rowsEnabled = false,
  rowCount = 0
}) {
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
  const sessionId = `${slugify(cleanTitle)}-${randomId("")}`;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const sessionPlanId = access?.unlimited ? "lifetime" : (access?.planId || "free");
  const placementConfig = normalizePlacementConfig({
    lateralEnabled: true,
    depthEnabled,
    rowsEnabled,
    rowCount: rowsEnabled ? rowCount : 0
  });

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
    zones: ZONE_LABELS,
    depths: DEPTH_LABELS,
    placementConfig,
    stats: { participantsCount: 0 },
    currentEffect: currentEffectPayload("idle", {
      color: "#111827",
      target: { zone: "all", depth: "all", row: "all" },
      durationMs: 0,
      label: "Repos"
    })
  };

  await set(ref(db, `${DATA_ROOT}/${sessionId}`), session);
  await update(ref(db, usagePath), {
    eventsCreated: used + 1,
    [`entities/${sessionId}`]: true,
    updatedAt: now
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
  await update(ref(db, `${DATA_ROOT}/${sessionId}`), {
    status: "closed",
    updatedAt: Date.now(),
    currentEffect: currentEffectPayload("idle", { color: "#111827", label: "Session fermée" })
  });
}

function cleanPlacement(session, placement = {}) {
  const config = normalizePlacementConfig(session?.placementConfig || {});
  const zone = ["left", "center", "right"].includes(placement.zone) ? placement.zone : "center";
  const depth = ["front", "middle", "back"].includes(placement.depth) ? placement.depth : "middle";
  let row = "";
  if (config.rowsEnabled) {
    const raw = Number(placement.row || 0);
    const max = config.rowCount || 80;
    if (Number.isFinite(raw) && raw >= 1 && raw <= max) row = String(Math.round(raw));
  }
  return {
    zone,
    zoneLabel: ZONE_LABELS[zone],
    depth: config.depthEnabled ? depth : "middle",
    depthLabel: config.depthEnabled ? DEPTH_LABELS[depth] : "",
    row
  };
}

export async function joinSession(sessionId, { name, zone, depth, row }) {
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
  const placement = cleanPlacement(session, { zone, depth, row });
  const participant = {
    id: participantId,
    name: String(name || "Participant").slice(0, 40),
    ...placement,
    joinedAt: now,
    lastSeenAt: now
  };
  await set(ref(db, `${DATA_ROOT}/${sessionId}/participants/${participantId}`), participant);
  localStorage.setItem(`glowup:${sessionId}:placement`, JSON.stringify({ name: participant.name, zone: participant.zone, depth: participant.depth, row: participant.row }));
  return { participantId, participant };
}

export async function updateParticipantPlacement(sessionId, participantId, placement = {}) {
  const session = await readSession(sessionId);
  if (!session || session.expiresAt <= Date.now() || session.status === "closed") throw new Error("Session GlowUp expirée ou indisponible.");
  const cleaned = cleanPlacement(session, placement);
  await update(ref(db, `${DATA_ROOT}/${sessionId}/participants/${participantId}`), {
    ...cleaned,
    lastSeenAt: Date.now()
  });
  localStorage.setItem(`glowup:${sessionId}:placement`, JSON.stringify(cleaned));
  return cleaned;
}

export function startHeartbeat(sessionId, participantId) {
  const tick = () => update(ref(db, `${DATA_ROOT}/${sessionId}/participants/${participantId}`), { lastSeenAt: Date.now() }).catch(() => {});
  tick();
  return window.setInterval(tick, 15000);
}
