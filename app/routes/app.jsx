import { redirect, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, PLAN_BASIC } from "../shopify.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);

  const url = new URL(request.url);

  // Skip billing check on pricing page to avoid infinite redirect
  if (!url.pathname.startsWith("/app/pricing")) {
    let hasActivePlan = false;

    try {
      const result = await billing.check({
        plans: [PLAN_BASIC],
        isTest: true,
      });
      hasActivePlan = result.hasActivePayment === true;
    } catch (e) {
      // If e is already a redirect Response, re-throw it
      if (e instanceof Response) throw e;
      // Any other error (plan not configured, API error) = treat as no subscription
      console.log("[PixelBoost] billing.check error:", e.message);
      hasActivePlan = false;
    }

    if (!hasActivePlan) {
      console.log("[PixelBoost] No active plan, redirecting to pricing");
      throw redirect("/app/pricing");
    }
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <ui-nav-menu>
          <a href="/app" rel="home">Home</a>
          <a href="/app/alttextsuggestions">Alt Text Generator</a>
          <a href="/app/productoptimization">Image Optimization</a>
          <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
          <a href="/app/billing">Billing</a>
        </ui-nav-menu>
        <Outlet />
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
