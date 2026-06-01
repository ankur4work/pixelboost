import { authenticate, PLAN_BASIC } from "../shopify.server";

// Billing initiation via GET — App Bridge always provides a fresh JWT on navigation,
// whereas POST actions from useSubmit can carry a stale/expired token causing 403.
export const loader = async ({ request }) => {
  try {
    const { billing } = await authenticate.admin(request);
    // eslint-disable-next-line no-undef
    const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    await billing.request({ plan: PLAN_BASIC, isTest: true, returnUrl: `${appUrl}/app` });
  } catch (e) {
    if (e instanceof Response) throw e;
    // auth or billing error — fall through, user stays on pricing wall
  }
  return null;
};

export default function Subscribe() {
  return null;
}
