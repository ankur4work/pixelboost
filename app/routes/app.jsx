import { useEffect, useState } from "react";
import { Outlet, useLoaderData, useRouteError, useSubmit, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, sessionStorage } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  BILLING_CONFIG,
} from "../billing.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

function isExpiredToken(e) {
  return e?.response?.networkStatusCode === 403 || String(e?.message).includes('Forbidden');
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let hasActivePlan = false;
  try {
    // Live subscription state from Shopify is the source of truth for managed
    // pricing — so subscribe/cancel done on Shopify's page reflect instantly.
    const state = await getBillingState(admin);
    hasActivePlan = state.hasActivePlan;
  } catch (e) {
    // Propagate redirect Responses (e.g. OAuth flow initiated by the library),
    // but treat 4xx Responses as an expired/revoked token — trigger re-auth
    // instead of letting a raw 403 reach the browser and crash React hydration.
    if (e instanceof Response) {
      if (e.status >= 300 && e.status < 400) throw e;
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan: false, needsReauth: true, shop: session.shop };
    }
    // Expired token via a plain Error object (networkStatusCode === 403 etc.)
    if (isExpiredToken(e)) {
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan: false, needsReauth: true, shop: session.shop };
    }
    hasActivePlan = false;
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    hasActivePlan,
    billing: {
      amount: BILLING_CONFIG.amount,
      amountYearly: BILLING_CONFIG.amountYearly,
      yearlyEnabled: BILLING_CONFIG.yearlyEnabled,
      currency: BILLING_CONFIG.currency,
      trialDays: BILLING_CONFIG.trialDays,
    },
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Managed pricing: send the merchant to Shopify's hosted plan-selection page.
  const { appHandle } = await getBillingState(admin);
  const url = managedPricingUrl(session.shop, appHandle);
  console.log("[BILLING] managed pricing redirect:", url);
  throw appBridgeRedirect(url);
};

const features = [
  "AI Alt Text Suggestions",
  "Product Image Optimization",
  "Page Speed Impact Analysis",
  "Performance Score Tracking",
  "Core Web Vitals (LCP, FID, CLS)",
];

function PricingWall({ amount, amountYearly, yearlyEnabled, currency, trialDays }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";
  const [cycle, setCycle] = useState("monthly");

  const isYearly = yearlyEnabled && cycle === "yearly";
  const price = isYearly ? amountYearly : amount;
  const unit = isYearly ? "/ yr" : "/ mo";
  const billingLine = isYearly ? "Billed yearly" : "Billed every 30 days";
  // Months saved vs paying monthly for a year (e.g. 720 → 600 = 2 months free).
  const monthsFree = amount > 0 ? Math.round((amount * 12 - amountYearly) / amount) : 0;

  // Posting to the /app action throws a 401 + reauthorize header; App Bridge
  // intercepts it and navigates the top frame to the managed pricing page,
  // where the merchant picks the actual monthly/yearly plan.
  const handleSubscribe = () => {
    submit({}, { method: "post", action: "/app" });
  };

  return (
    <div style={pricingStyles.page}>
      <p style={pricingStyles.appLabel}>PIXELBOOST</p>
      <h1 style={pricingStyles.heading}>Simple pricing.</h1>
      <p style={pricingStyles.subheading}>
        Everything you need to optimize your store's images.
      </p>

      <div style={pricingStyles.card}>
        <div style={pricingStyles.cardTop}>
          <div style={pricingStyles.decorCircle} />
          <div style={pricingStyles.topRow}>
            <span style={pricingStyles.planBadge}>BASIC PLAN</span>
            {yearlyEnabled && (
              <div style={pricingStyles.toggle}>
                <button
                  type="button"
                  onClick={() => setCycle("monthly")}
                  style={cycle === "monthly" ? pricingStyles.toggleBtnActive : pricingStyles.toggleBtn}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setCycle("yearly")}
                  style={cycle === "yearly" ? pricingStyles.toggleBtnActive : pricingStyles.toggleBtn}
                >
                  Yearly{monthsFree > 0 ? ` · ${monthsFree} mo free` : ""}
                </button>
              </div>
            )}
          </div>
          <div style={pricingStyles.priceRow}>
            <span style={pricingStyles.priceCurrency}>$</span>
            <span style={pricingStyles.priceAmount}>{price}</span>
            <span style={pricingStyles.priceUnit}>&nbsp;{unit}</span>
          </div>
          <p style={pricingStyles.billingNote}>
            {trialDays > 0 ? `${trialDays}-day free trial · ` : ""}{billingLine} · {currency}
          </p>
        </div>

        <div style={pricingStyles.cardBottom}>
          <p style={pricingStyles.includedLabel}>WHAT'S INCLUDED</p>
          <div style={pricingStyles.featureList}>
            {features.map((f, i) => (
              <div key={i} style={{
                ...pricingStyles.featureRow,
                borderBottom: i < features.length - 1 ? "1px solid #F3F4F6" : "none"
              }}>
                <div style={pricingStyles.featureIcon}>+</div>
                <span style={pricingStyles.featureText}>{f}</span>
              </div>
            ))}
          </div>

          <button
            style={{ ...pricingStyles.subscribeBtn, opacity: isLoading ? 0.7 : 1 }}
            onClick={handleSubscribe}
            disabled={isLoading}
          >
            {isLoading
              ? "Redirecting to Shopify..."
              : trialDays > 0
                ? `Start ${trialDays}-day free trial`
                : isYearly
                  ? `Subscribe — $${price} / year`
                  : `Subscribe — $${price} / month`}
          </button>

          <p style={pricingStyles.disclaimer}>
            Secure billing through Shopify · Cancel anytime
          </p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { apiKey, hasActivePlan, needsReauth, shop, billing } = useLoaderData();

  // Expired token: break out of the Shopify iframe so OAuth runs in the top frame
  useEffect(() => {
    if (needsReauth && shop) {
      window.top.location.href = `/auth?shop=${shop}`;
    }
  }, [needsReauth, shop]);

  if (needsReauth) return null;

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {hasActivePlan ? (
          <>
            <ui-nav-menu>
              <a href="/app" rel="home">Home</a>
              <a href="/app/alttextsuggestions">Alt Text Generator</a>
              <a href="/app/productoptimization">Image Optimization</a>
              <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
              <a href="/app/billing">Billing</a>
            </ui-nav-menu>
            <Outlet />
          </>
        ) : (
          <PricingWall
            amount={billing?.amount ?? 60}
            amountYearly={billing?.amountYearly ?? 600}
            yearlyEnabled={billing?.yearlyEnabled ?? true}
            currency={billing?.currency ?? "USD"}
            trialDays={billing?.trialDays ?? 0}
          />
        )}
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

const pricingStyles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#F5F4EF",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px 24px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  appLabel: {
    fontSize: 10, fontWeight: 600, letterSpacing: "0.2em",
    color: "#9CA3AF", margin: "0 0 8px 0", textTransform: "uppercase",
  },
  heading: {
    fontSize: 30, fontWeight: 800, color: "#111827",
    margin: "0 0 6px 0", textAlign: "center", letterSpacing: "-0.5px", lineHeight: 1.1,
  },
  subheading: {
    fontSize: 13, color: "#6B7280", margin: "0 0 16px 0", textAlign: "center",
  },
  card: {
    width: "100%", maxWidth: 460, borderRadius: 16, overflow: "hidden",
    boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
  },
  cardTop: {
    background: "#1C1C1E", padding: "20px 24px 16px 24px",
    position: "relative", overflow: "hidden",
  },
  decorCircle: {
    position: "absolute", top: -30, right: -30,
    width: 130, height: 130, borderRadius: "50%",
    background: "rgba(255,255,255,0.04)",
  },
  topRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 8, marginBottom: 10,
  },
  planBadge: {
    display: "inline-block", background: "#2C2C2E", color: "#D1D5DB",
    fontSize: 10, fontWeight: 700, letterSpacing: "0.15em",
    padding: "4px 10px", borderRadius: 999,
  },
  toggle: {
    display: "flex", background: "#2C2C2E", borderRadius: 999, padding: 2,
  },
  toggleBtn: {
    border: "none", background: "transparent", color: "rgba(255,255,255,0.55)",
    fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 999,
    cursor: "pointer", whiteSpace: "nowrap",
  },
  toggleBtnActive: {
    border: "none", background: "#FFFFFF", color: "#1C1C1E",
    fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
    cursor: "pointer", whiteSpace: "nowrap",
  },
  priceRow: { display: "flex", alignItems: "flex-start", marginBottom: 4 },
  priceCurrency: { fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginTop: 7 },
  priceAmount: { fontSize: 52, fontWeight: 800, color: "white", lineHeight: 1 },
  priceUnit: { fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 10, fontWeight: 400 },
  billingNote: { fontSize: 11, color: "rgba(255,255,255,0.4)", margin: 0 },
  cardBottom: { background: "white", padding: "16px 24px 20px 24px" },
  includedLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.15em",
    color: "#9CA3AF", margin: "0 0 8px 0", textTransform: "uppercase",
  },
  featureList: { marginBottom: 14 },
  featureRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" },
  featureIcon: {
    width: 24, height: 24, borderRadius: 6, background: "#F5F4EF",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, color: "#6B7280", flexShrink: 0, fontWeight: 300,
  },
  featureText: { fontSize: 13, color: "#111827" },
  subscribeBtn: {
    width: "100%", padding: "12px", background: "#1C1C1E",
    color: "white", border: "none", borderRadius: 10,
    fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 8,
  },
  disclaimer: { textAlign: "center", fontSize: 11, color: "#9CA3AF", margin: 0 },
};
