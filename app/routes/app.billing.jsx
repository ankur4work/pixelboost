import { useLoaderData, useSubmit } from "react-router";
import { authenticate, PLAN_BASIC } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Badge,
  List,
  Divider,
  Banner,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);

  const billingCheck = await billing.require({
    plans: [PLAN_BASIC],
    isTest: true,
    onFailure: () => null,
  }).catch(() => null);

  const hasActivePlan = !!billingCheck;

  return { hasActivePlan, plan: PLAN_BASIC, amount: 30 };
};

export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "subscribe") {
    await billing.request({ plan: PLAN_BASIC, isTest: true });
  }

  if (actionType === "cancel") {
    const billingCheck = await billing.require({
      plans: [PLAN_BASIC],
      isTest: true,
      onFailure: () => null,
    }).catch(() => null);

    if (billingCheck) {
      await billing.cancel({
        subscriptionId: billingCheck.appSubscriptions[0]?.id,
        isTest: true,
        prorate: true,
      });
    }
  }

  return null;
};

export default function BillingPage() {
  const { hasActivePlan, amount } = useLoaderData();
  const submit = useSubmit();

  const features = [
    "AI Alt Text Suggestions (OpenAI + Claude)",
    "Product Image Optimization",
    "Automatic WebP Conversion",
    "Bulk Processing",
    "Page Speed Impact Analysis",
    "Performance Score Tracking",
    "Core Web Vitals (LCP, FID, CLS)",
    "Before/After Metrics",
  ];

  const handleSubscribe = () => {
    const formData = new FormData();
    formData.append("actionType", "subscribe");
    submit(formData, { method: "post" });
  };

  const handleCancel = () => {
    const formData = new FormData();
    formData.append("actionType", "cancel");
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="PixelBoost — Billing"
      subtitle="Manage your PixelBoost subscription"
    >
      <Layout>
        {hasActivePlan && (
          <Layout.Section>
            <Banner title="Active subscription" tone="success">
              You are on the Basic plan. All features are unlocked.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="200">
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingXl" as="h2">Basic</Text>
                    {hasActivePlan && <Badge tone="success">Active</Badge>}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">Everything you need to optimize your store</Text>
                </BlockStack>
                <BlockStack gap="100" inlineAlign="end">
                  <Text variant="heading3xl" as="p">${amount}</Text>
                  <Text variant="bodySm" as="p" tone="subdued">/ month</Text>
                </BlockStack>
              </InlineStack>

              <Divider />

              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">Features included</Text>
                <List type="bullet">
                  {features.map((feature) => (
                    <List.Item key={feature}>{feature}</List.Item>
                  ))}
                </List>
              </BlockStack>

              <Divider />

              <InlineStack align="end" gap="300">
                {hasActivePlan ? (
                  <Button tone="critical" variant="plain" onClick={handleCancel}>
                    Cancel subscription
                  </Button>
                ) : (
                  <Button variant="primary" size="large" onClick={handleSubscribe}>
                    Subscribe — $30/month
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockStart="400">
            <Text variant="bodySm" as="p" tone="subdued">
              Billed every 30 days through Shopify. Cancel anytime from this page or your Shopify admin.
              Test mode is active — no real charges will occur during development.
            </Text>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
