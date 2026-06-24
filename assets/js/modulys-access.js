import { app, db, ref, get, set } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const auth = getAuth(app);
const DEFAULT_PLAN_LIMITS = {
  free: { eventsPerPeriod: 1, quotaPeriod: "month", participantsPerEvent: 30, photosPerParticipant: 1, maxPhotoSizeBytes: 900000, retentionHours: 24 },
  event_pass: { eventsPerPeriod: 1, quotaPeriod: "grant", participantsPerEvent: 100, photosPerParticipant: 1, maxPhotoSizeBytes: 1000000, retentionHours: 48 },
  monthly: { eventsPerPeriod: 20, quotaPeriod: "month", participantsPerEvent: 150, photosPerParticipant: 1, maxPhotoSizeBytes: 1000000, retentionHours: 72 },
  annual: { eventsPerPeriod: 250, quotaPeriod: "year", participantsPerEvent: 200, photosPerParticipant: 1, maxPhotoSizeBytes: 1000000, retentionHours: 72 },
  lifetime: { eventsPerPeriod: 300, quotaPeriod: "year", participantsPerEvent: 250, photosPerParticipant: 1, maxPhotoSizeBytes: 1000000, retentionHours: 72 }
};

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isActiveGrant(grant) {
  if (!grant) return false;
  if (grant === true) return true;
  const status = String(grant.status || "active").toLowerCase();
  if (!["active", "trial", "lifetime"].includes(status)) return false;
  if (grant.lifetime === true || status === "lifetime") return true;
  const expiresAt = normalizeTimestamp(grant.expiresAt);
  return !expiresAt || expiresAt > Date.now();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function currentBillingPeriod(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function currentBillingYear(date = new Date()) {
  return String(date.getFullYear());
}

function normalizePlanId(value = "free") {
  const id = String(value || "free").trim().toLowerCase();
  return Object.hasOwn(DEFAULT_PLAN_LIMITS, id) ? id : "free";
}

function entitlementGrantId(entitlement = {}) {
  return String(entitlement.grantId || entitlement.purchaseId || entitlement.id || "").trim();
}

export function waitForCurrentUser(timeoutMs = 1600) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (user) => {
      if (done) return;
      done = true;
      try { unsubscribe(); } catch {}
      resolve(user || null);
    };
    unsubscribe = onAuthStateChanged(auth, finish, () => finish(null));
    window.setTimeout(() => finish(auth.currentUser || null), timeoutMs);
  });
}

function resolveLimits(moduleKey, planId, moduleData = {}, planData = {}) {
  const normalizedPlanId = normalizePlanId(planId);
  const defaults = DEFAULT_PLAN_LIMITS[normalizedPlanId];
  const modulePlan = moduleData?.limits?.[normalizedPlanId] || {};
  const planLimits = planData?.limits || {};
  const perModule = planLimits?.[moduleKey] || {};
  const eventsPerPeriod = Number(modulePlan.eventsPerPeriod || perModule.eventsPerPeriod || planLimits.eventsPerPeriod || modulePlan.eventsPerMonth || perModule.eventsPerMonth || planLimits.eventsPerMonth || modulePlan.eventsPerYear || perModule.eventsPerYear || planLimits.eventsPerYear || defaults.eventsPerPeriod);
  return {
    eventsPerPeriod,
    quotaPeriod: String(modulePlan.quotaPeriod || perModule.quotaPeriod || planLimits.quotaPeriod || defaults.quotaPeriod),
    participantsPerEvent: Number(modulePlan.participantsPerEvent || perModule.participantsPerEvent || planLimits.participantsPerEvent || defaults.participantsPerEvent),
    photosPerParticipant: Number(modulePlan.photosPerParticipant || perModule.photosPerParticipant || planLimits.photosPerParticipant || defaults.photosPerParticipant),
    maxPhotoSizeBytes: Number(modulePlan.maxPhotoSizeBytes || perModule.maxPhotoSizeBytes || planLimits.maxPhotoSizeBytes || defaults.maxPhotoSizeBytes),
    retentionHours: Number(modulePlan.retentionHours || perModule.retentionHours || planLimits.retentionHours || defaults.retentionHours)
  };
}

async function resolveBillingPeriod(planId, limits, entitlement = {}) {
  if (limits.quotaPeriod === "grant") {
    const grantId = entitlementGrantId(entitlement);
    if (!/^grant-[A-Za-z0-9_-]{6,58}$/.test(grantId)) throw new Error("Ce Pass événement est indisponible. Veuillez réessayer ou contacter l’organisateur.");
    return grantId;
  }
  const periodName = limits.quotaPeriod === "year" ? "year" : "month";
  const periodSnap = await get(ref(db, `quotaPeriods/${periodName}`));
  if (!periodSnap.exists()) throw new Error("Période d’utilisation indisponible. Veuillez réessayer.");
  return String(periodSnap.val());
}

export async function getAccessForUser(moduleKey, user) {
  const moduleSnap = await get(ref(db, `modules/${moduleKey}`));
  const moduleData = moduleSnap.val() || null;

  if (!moduleData) return { allowed: false, reason: "module_not_declared", module: null };
  if (moduleData.active === false) return { allowed: false, reason: "module_inactive", module: moduleData };
  if (moduleData.accessMode === "public") return { allowed: true, reason: "public", module: moduleData };
  if (!user) return { allowed: false, reason: "not_authenticated", module: moduleData };
  if (user.isAnonymous) return { allowed: false, reason: "anonymous_not_allowed", module: moduleData };

  const [adminsSnap, adminSnap, accessSnap, subscriptionSnap] = await Promise.all([
    get(ref(db, `admins/${user.uid}`)),
    get(ref(db, `admin/${user.uid}`)),
    get(ref(db, `userAccess/${user.uid}`)),
    get(ref(db, `subscriptions/${user.uid}`))
  ]);

  const isAdmin = Boolean(adminsSnap.val() || adminSnap.val());
  const access = accessSnap.val() || {};
  const subscription = subscriptionSnap.val() || null;
  if (isAdmin) {
    const limits = { ...DEFAULT_PLAN_LIMITS.lifetime };
    return { allowed: true, reason: "admin", module: moduleData, isAdmin, access, subscription, planId: "admin", limits, billingPeriod: currentBillingYear(), entitlement: access, unlimited: true };
  }

  let reason = "";
  let planId = "free";
  let entitlement = access;
  if (isActiveGrant(access.allModules)) {
    planId = normalizePlanId(access.planId);
    reason = planId === "free" ? "free_all_modules" : "all_modules";
  } else if (isActiveGrant(access.modules?.[moduleKey])) {
    planId = normalizePlanId(access.planId);
    entitlement = typeof access.modules[moduleKey] === "object" ? { ...access, ...access.modules[moduleKey] } : access;
    reason = planId === "free" ? "free_module_grant" : "module_grant";
  } else if (isActiveGrant(subscription) && (subscription.scope === "allModules" || subscription.modules?.[moduleKey] === true || isActiveGrant(subscription.modules?.[moduleKey]))) {
    planId = normalizePlanId(subscription.planId || subscription.id);
    entitlement = subscription;
    reason = planId === "free" ? "free_subscription" : "subscription";
  } else if (moduleData.accessMode === "free_authenticated") {
    reason = "free_authenticated";
    planId = "free";
    entitlement = access;
  } else {
    const freeLimits = resolveLimits(moduleKey, "free", moduleData, {});
    return { allowed: false, reason: "no_grant", module: moduleData, isAdmin, access, subscription, planId: "none", limits: freeLimits, unlimited: false };
  }

  const planSnap = await get(ref(db, `plans/${planId}`));
  const planData = planSnap.val() || {};
  if (planData.active === false) return { allowed: false, reason: "plan_inactive", module: moduleData, isAdmin, access, subscription, planId, limits: null, unlimited: false };
  const limits = resolveLimits(moduleKey, planId, moduleData, planData);
  const billingPeriod = await resolveBillingPeriod(planId, limits, entitlement);
  return { allowed: true, reason, module: moduleData, plan: planData, isAdmin, access, subscription, planId, limits, billingPeriod, entitlement, unlimited: false };
}

export function isFreeLimitError(error) {
  return Boolean(error && (["modulys/free-limit-reached", "modulys/offer-limit-reached"].includes(error.code) || String(error.message || "").toLowerCase().includes("limite de l’offre atteinte")));
}

export function upgradeOfferHtml(moduleKey, error = {}) {
  const limits = error.limits || {};
  const period = error.period || currentBillingPeriod();
  const max = Number(limits.eventsPerPeriod || 1);
  const offerName = escapeHtml(error.offerName || "Découverte");
  return `<div class="upgrade-box">
    <strong>Limite de l’offre atteinte</strong>
    <span>L’offre ${offerName} permet ${max} création${max > 1 ? "s" : ""} sur cette période pour GlowUp. La limite est déjà utilisée pour ${escapeHtml(period)}.</span>
    <div class="upgrade-actions">
      <a class="btn btn-primary" href="https://modulys.top/#tarifs" target="_blank" rel="noopener">Voir les offres</a>
      <a class="btn btn-secondary" href="https://modulys.top/#contact" target="_blank" rel="noopener">Débloquer mon accès</a>
    </div>
    <small>Options disponibles : Pass événement, Abonnement mensuel, Abonnement annuel ou Lifetime.</small>
  </div>`;
}

export function renderFreeLimitUpgrade(target, moduleKey, error = {}) {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) return false;
  el.innerHTML = upgradeOfferHtml(moduleKey, error);
  return true;
}

function reasonLabel(reason) {
  return {
    not_authenticated: "Vous devez vous connecter avec votre compte Modulys pour ouvrir ce module.",
    anonymous_not_allowed: "Vous utilisez actuellement un accès invité. Connectez-vous avec votre compte Modulys pour créer ou gérer une session.",
    module_not_declared: "GlowUp est temporairement indisponible.",
    module_inactive: "GlowUp est actuellement désactivé.",
    plan_inactive: "L’offre associée à votre compte est actuellement désactivée.",
    no_grant: "Votre compte ne possède pas encore les droits pour ce module."
  }[reason] || "Accès non disponible.";
}

function renderLoginRequired(moduleKey, reason) {
  document.body.innerHTML = `<main class="access-screen"><section class="access-card">
    <p class="eyebrow">Modulys</p>
    <h1>Connexion requise</h1>
    <p>${escapeHtml(reasonLabel(reason))}</p>
    <form id="modulysModuleLoginForm" class="stack">
      <input name="email" type="email" autocomplete="email" required placeholder="Email">
      <input name="password" type="password" autocomplete="current-password" required placeholder="Mot de passe">
      <button class="btn btn-primary" type="submit">Me connecter</button>
      <a class="btn btn-secondary" href="https://modulys.top/mes-modules.html">Créer un compte</a>
      <p id="modulysLoginFeedback" class="status"></p>
    </form>
  </section></main>`;
  document.querySelector("#modulysModuleLoginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = document.querySelector("#modulysLoginFeedback");
    const form = event.currentTarget;
    try {
      if (feedback) feedback.textContent = "Connexion…";
      await signInWithEmailAndPassword(auth, form.email.value.trim(), form.password.value);
      location.reload();
    } catch (error) {
      if (feedback) feedback.textContent = "Connexion impossible. Vérifiez l’email et le mot de passe.";
      console.warn("Modulys module login failed", error);
    }
  });
}

function renderBlocked(moduleKey, reason) {
  if (reason === "not_authenticated" || reason === "anonymous_not_allowed") return renderLoginRequired(moduleKey, reason);
  document.body.innerHTML = `<main class="access-screen"><section class="access-card"><p class="eyebrow">Modulys</p><h1>Accès non disponible</h1><p>${escapeHtml(reasonLabel(reason))}</p><a class="btn btn-primary" href="https://modulys.top/mes-modules.html">Retour à mes modules</a></section></main>`;
}

export async function enforceModuleAccess(moduleKey, options = {}) {
  const mode = options.mode || "soft";
  try {
    const user = await waitForCurrentUser(options.timeoutMs || 1800);
    const access = await getAccessForUser(moduleKey, user);
    if (access.allowed) return { ok: true, user, access };
    if (mode === "hard") {
      renderBlocked(moduleKey, access.reason);
      return { ok: false, user, access };
    }
    return { ok: true, user, access };
  } catch (error) {
    console.warn("Modulys access check failed", error);
    if (mode === "hard") renderBlocked(moduleKey, "access_check_error");
    return { ok: false, user: null, access: null };
  }
}

export async function logoutFromModule(redirectUrl = "https://modulys.top/mes-modules.html") {
  try {
    await signOut(auth);
  } finally {
    window.location.href = redirectUrl;
  }
}

export { auth, signOut };
