// Managed-pricing billing helpers.
//
// This app is a Shopify "Managed Pricing" app, so it CANNOT use the Billing API
// to create charges (appSubscriptionCreate is blocked). Plans live in the
// Partner Dashboard and merchants subscribe/cancel/change on Shopify's hosted
// pricing page. The app's job is:
//   1. read the live subscription state (source of truth) to gate features, and
//   2. send merchants to the hosted pricing page to subscribe or cancel.

// Central, env-overridable billing config — change price/trial without editing
// code. Set these in your environment (e.g. Coolify / .env):
//   BILLING_AMOUNT=60        monthly price shown in the app
//   BILLING_TRIAL_DAYS=0     free-trial length shown in the app (0 = no trial)
//   BILLING_PLAN_NAME=Basic  plan name
//   BILLING_CURRENCY=USD     currency code
//
// IMPORTANT: Because this is Managed Pricing, the amount the merchant is
// actually CHARGED and the real free-trial length come from the plan in the
// Partner Dashboard — these env values only control what the app DISPLAYS (and
// the fallback billing config). Keep them in sync with the Partner Dashboard plan.
export const BILLING_CONFIG = {
  planName: process.env.BILLING_PLAN_NAME || "Basic",
  amount: Number(process.env.BILLING_AMOUNT ?? 60),
  currency: process.env.BILLING_CURRENCY || "USD",
  intervalDays: 30,
  trialDays: Number(process.env.BILLING_TRIAL_DAYS ?? 0),
};

const INSTALLATION_QUERY = `#graphql
  query AppInstallation {
    currentAppInstallation {
      app { handle }
      activeSubscriptions { id name status test currentPeriodEnd }
    }
  }`;

const CANCEL_MUTATION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

const FALLBACK_APP_HANDLE = "pixelboost-1";

// Reads the app's handle + active subscription in a single round trip.
// Returns { appHandle, activeSubscription, hasActivePlan }.
// Lets an auth Response (e.g. 401 reauthorize) propagate so the caller can
// rethrow it; any other error is treated as "no active plan".
export async function getBillingState(admin) {
  const resp = await admin.graphql(INSTALLATION_QUERY);
  const json = await resp.json();
  const inst = json?.data?.currentAppInstallation;
  const subs = inst?.activeSubscriptions || [];
  const active = subs.find((s) => s.status === "ACTIVE") || null;
  return {
    appHandle: inst?.app?.handle || FALLBACK_APP_HANDLE,
    activeSubscription: active,
    hasActivePlan: Boolean(active),
  };
}

// Builds the Shopify-hosted managed-pricing page URL where merchants can
// subscribe, change, or cancel their plan.
export function managedPricingUrl(shop, appHandle) {
  const storeHandle = shop.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle || FALLBACK_APP_HANDLE}/pricing_plans`;
}

// App Bridge intercepts a 401 carrying this header and navigates the TOP frame
// to the URL — the only reliable way to leave the embedded iframe to an
// admin.shopify.com page (window.top.location is a cross-origin SecurityError).
export function appBridgeRedirect(url) {
  return new Response(null, {
    status: 401,
    headers: new Headers({
      "X-Shopify-API-Request-Failure-Reauthorize-Url": url,
      "Access-Control-Expose-Headers":
        "X-Shopify-API-Request-Failure-Reauthorize-Url",
    }),
  });
}

// Attempts an in-app cancel via appSubscriptionCancel. Returns the cancelled
// subscription on success; throws on userErrors (caller falls back to sending
// the merchant to the hosted pricing page to cancel there).
export async function cancelSubscription(admin, id) {
  const resp = await admin.graphql(CANCEL_MUTATION, { variables: { id } });
  const json = await resp.json();
  const errs = json?.data?.appSubscriptionCancel?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return json?.data?.appSubscriptionCancel?.appSubscription || null;
}
