import { Outlet, useLoaderData, useRouteError, useSubmit, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, PLAN_BASIC } from "../shopify.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);

  let hasActivePlan = false;
  try {
    const result = await billing.check({ plans: [PLAN_BASIC], isTest: true });
    hasActivePlan = result.hasActivePayment === true;
  } catch (e) {
    if (e instanceof Response) throw e;
    hasActivePlan = false;
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan };
};

export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  // Redirects to Shopify billing approval page
  await billing.request({ plan: PLAN_BASIC, isTest: true });
  return null;
};

const features = [
  "AI Alt Text Suggestions",
  "Product Image Optimization",
  "Page Speed Impact Analysis",
  "Performance Score Tracking",
  "Core Web Vitals (LCP, FID, CLS)",
];

function PricingWall() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

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
          <span style={pricingStyles.planBadge}>BASIC PLAN</span>
          <div style={pricingStyles.priceRow}>
            <span style={pricingStyles.priceCurrency}>$</span>
            <span style={pricingStyles.priceAmount}>30</span>
            <span style={pricingStyles.priceUnit}>&nbsp;/ mo</span>
          </div>
          <p style={pricingStyles.billingNote}>Billed every 30 days · USD</p>
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
            {isLoading ? "Redirecting to Shopify..." : "Subscribe — $30 / month"}
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
  const { apiKey, hasActivePlan } = useLoaderData();

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
          <PricingWall />
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
    padding: "48px 24px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  appLabel: {
    fontSize: 11, fontWeight: 600, letterSpacing: "0.2em",
    color: "#9CA3AF", margin: "0 0 20px 0", textTransform: "uppercase",
  },
  heading: {
    fontSize: 52, fontWeight: 800, color: "#111827",
    margin: "0 0 12px 0", textAlign: "center", letterSpacing: "-1px", lineHeight: 1.1,
  },
  subheading: {
    fontSize: 16, color: "#6B7280", margin: "0 0 40px 0", textAlign: "center",
  },
  card: {
    width: "100%", maxWidth: 480, borderRadius: 20, overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.12)",
  },
  cardTop: {
    background: "#1C1C1E", padding: "36px 36px 32px 36px",
    position: "relative", overflow: "hidden",
  },
  decorCircle: {
    position: "absolute", top: -40, right: -40,
    width: 200, height: 200, borderRadius: "50%",
    background: "rgba(255,255,255,0.04)",
  },
  planBadge: {
    display: "inline-block", background: "#2C2C2E", color: "#D1D5DB",
    fontSize: 11, fontWeight: 700, letterSpacing: "0.15em",
    padding: "6px 14px", borderRadius: 999, marginBottom: 24,
  },
  priceRow: { display: "flex", alignItems: "flex-start", marginBottom: 8 },
  priceCurrency: { fontSize: 28, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginTop: 10 },
  priceAmount: { fontSize: 80, fontWeight: 800, color: "white", lineHeight: 1 },
  priceUnit: { fontSize: 20, color: "rgba(255,255,255,0.5)", marginTop: 16, fontWeight: 400 },
  billingNote: { fontSize: 13, color: "rgba(255,255,255,0.4)", margin: 0 },
  cardBottom: { background: "white", padding: "32px 36px 36px 36px" },
  includedLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.15em",
    color: "#9CA3AF", margin: "0 0 20px 0", textTransform: "uppercase",
  },
  featureList: { marginBottom: 28 },
  featureRow: { display: "flex", alignItems: "center", gap: 14, padding: "14px 0" },
  featureIcon: {
    width: 32, height: 32, borderRadius: 8, background: "#F5F4EF",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 16, color: "#6B7280", flexShrink: 0, fontWeight: 300,
  },
  featureText: { fontSize: 15, color: "#111827" },
  subscribeBtn: {
    width: "100%", padding: "16px", background: "#1C1C1E",
    color: "white", border: "none", borderRadius: 12,
    fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 12,
  },
  disclaimer: { textAlign: "center", fontSize: 12, color: "#9CA3AF", margin: 0 },
};
