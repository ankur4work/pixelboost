import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, login } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  // Auto-initiate OAuth when shop is known (re-auth after expired token).
  // The login() function requires a POST with shop in the body to generate
  // the OAuth URL + state cookie — a plain GET would just render the form.
  if (shop) {
    const postRequest = new Request(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ shop }).toString(),
    });
    return login(postRequest);
  }

  await authenticate.admin(request);
  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
