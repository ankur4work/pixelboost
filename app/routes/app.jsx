import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError, useSubmit, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, PLAN_BASIC, sessionStorage } from "../shopify.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

function isExpiredToken(e) {
  return e?.response?.networkStatusCode === 403 || String(e?.message).includes('Forbidden');
}

export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);

  let hasActivePlan = false;
  try {
    const result = await billing.check({ plans: [PLAN_BASIC], isTest: true });
    hasActivePlan = result.hasActivePayment === true;
  } catch (e) {
    if (e instanceof Response) throw e;
    // Expired non-expiring token: delete bad session then signal client to break out for OAuth
    if (isExpiredToken(e)) {
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan: false, needsReauth: true, shop: session.shop };
    }
    hasActivePlan = false;
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const storeHandle = session.shop.replace(".myshopify.com", "");

  // Managed pricing apps (plans defined in the Partner Dashboard) CANNOT use
  // the Billing API. Instead we redirect the merchant to Shopify's hosted
  // plan-selection page: /charges/<app-handle>/pricing_plans
  // Fetch this app's own handle at runtime so the URL is always correct.
  let appHandle = "pixelboost-1"; // fallback (known install handle)
  try {
    const resp = await admin.graphql(
      `#graphql
      query AppHandle { currentAppInstallation { app { handle } } }`,
    );
    const json = await resp.json();
    const h = json?.data?.currentAppInstallation?.app?.handle;
    console.log("[BILLING] app handle from API:", h);
    if (h) appHandle = h;
  } catch (e) {
    console.error("[BILLING] handle fetch failed:", e?.message);
  }

  const pricingUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
  console.log("[BILLING] managed pricing redirect:", pricingUrl);

  // App Bridge intercepts a 401 carrying this header and navigates the TOP
  // frame to the URL. This works cross-origin to admin.shopify.com, whereas
  // window.top.location (cross-origin SecurityError) and window.shopify.navigate
  // (SPA-only) do not.
  throw new Response(null, {
    status: 401,
    headers: new Headers({
      "X-Shopify-API-Request-Failure-Reauthorize-Url": pricingUrl,
      "Access-Control-Expose-Headers":
        "X-Shopify-API-Request-Failure-Reauthorize-Url",
    }),
  });
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

  // Posting to the /app action throws a 401 + reauthorize header; App Bridge
  // intercepts it and navigates the top frame to the managed pricing page.
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
  const { apiKey, hasActivePlan, needsReauth, shop } = useLoaderData();

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
  planBadge: {
    display: "inline-block", background: "#2C2C2E", color: "#D1D5DB",
    fontSize: 10, fontWeight: 700, letterSpacing: "0.15em",
    padding: "4px 10px", borderRadius: 999, marginBottom: 10,
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
