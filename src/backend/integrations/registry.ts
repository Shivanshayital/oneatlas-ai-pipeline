import { Integration } from "../types";

// ============================================================================
// Integration Registry
// ============================================================================

export const INTEGRATION_REGISTRY: Record<string, Integration> = {
  slack: {
    id: "slack",
    displayName: "Slack",
    authType: "oauth2",
    triggers: [
      {
        id: "message_received",
        name: "Message Received",
        description: "Triggered when a message is posted to a channel",
        payload_schema: {
          channel_id: "string",
          user_id: "string",
          message: "string",
          timestamp: "number",
        },
      },
      {
        id: "reaction_added",
        name: "Reaction Added",
        description: "Triggered when a reaction is added to a message",
        payload_schema: {
          message_ts: "string",
          reaction: "string",
          user_id: "string",
        },
      },
    ],
    actions: [
      {
        id: "send_message",
        name: "Send Message",
        description: "Send a message to a Slack channel",
        parameters: {
          channel: "string",
          text: "string",
          thread_ts: "string?",
        },
      },
      {
        id: "create_thread",
        name: "Create Thread",
        description: "Create a new thread with a message",
        parameters: {
          channel: "string",
          message: "string",
        },
      },
      {
        id: "add_reaction",
        name: "Add Reaction",
        description: "Add an emoji reaction to a message",
        parameters: {
          channel: "string",
          timestamp: "string",
          emoji: "string",
        },
      },
    ],
    icon: "💬",
    documentationUrl: "https://api.slack.com/docs",
  },

  gmail: {
    id: "gmail",
    displayName: "Gmail",
    authType: "oauth2",
    triggers: [
      {
        id: "email_received",
        name: "Email Received",
        description: "Triggered when a new email is received",
        payload_schema: {
          from: "string",
          to: "string",
          subject: "string",
          body: "string",
          timestamp: "number",
        },
      },
      {
        id: "email_labeled",
        name: "Email Labeled",
        description: "Triggered when an email is assigned a label",
        payload_schema: {
          email_id: "string",
          label: "string",
          from: "string",
        },
      },
    ],
    actions: [
      {
        id: "send_email",
        name: "Send Email",
        description: "Send an email",
        parameters: {
          to: "string",
          subject: "string",
          body: "string",
          cc: "string?",
          bcc: "string?",
        },
      },
      {
        id: "apply_label",
        name: "Apply Label",
        description: "Apply a label to an email",
        parameters: {
          email_id: "string",
          label: "string",
        },
      },
      {
        id: "archive_email",
        name: "Archive Email",
        description: "Archive an email",
        parameters: {
          email_id: "string",
        },
      },
    ],
    icon: "📧",
    documentationUrl: "https://developers.google.com/gmail/api",
  },

  whatsapp: {
    id: "whatsapp",
    displayName: "WhatsApp",
    authType: "api_key",
    triggers: [
      {
        id: "message_received",
        name: "Message Received",
        description: "Triggered when a message is received",
        payload_schema: {
          from: "string",
          text: "string",
          message_type: "string",
          timestamp: "number",
        },
      },
      {
        id: "status_changed",
        name: "Status Changed",
        description: "Triggered when message delivery status changes",
        payload_schema: {
          message_id: "string",
          status: "string",
          timestamp: "number",
        },
      },
    ],
    actions: [
      {
        id: "send_message",
        name: "Send Message",
        description: "Send a text message",
        parameters: {
          phone_number: "string",
          message: "string",
        },
      },
      {
        id: "send_template",
        name: "Send Template",
        description: "Send a pre-approved template message",
        parameters: {
          phone_number: "string",
          template_name: "string",
          parameters: "object",
        },
      },
      {
        id: "send_media",
        name: "Send Media",
        description: "Send an image, document, or video",
        parameters: {
          phone_number: "string",
          media_url: "string",
          caption: "string?",
        },
      },
    ],
    icon: "💚",
    documentationUrl: "https://developers.facebook.com/docs/whatsapp",
  },

  stripe: {
    id: "stripe",
    displayName: "Stripe",
    authType: "api_key",
    triggers: [
      {
        id: "payment_succeeded",
        name: "Payment Succeeded",
        description: "Triggered when a payment is successfully processed",
        payload_schema: {
          charge_id: "string",
          amount: "number",
          customer_id: "string",
          currency: "string",
          timestamp: "number",
        },
      },
      {
        id: "payment_failed",
        name: "Payment Failed",
        description: "Triggered when a payment fails",
        payload_schema: {
          charge_id: "string",
          amount: "number",
          customer_id: "string",
          failure_reason: "string",
          timestamp: "number",
        },
      },
      {
        id: "invoice_paid",
        name: "Invoice Paid",
        description: "Triggered when an invoice is paid",
        payload_schema: {
          invoice_id: "string",
          customer_id: "string",
          amount: "number",
          timestamp: "number",
        },
      },
    ],
    actions: [
      {
        id: "create_payment",
        name: "Create Payment",
        description: "Create a new payment",
        parameters: {
          amount: "number",
          currency: "string",
          customer_id: "string",
          description: "string?",
        },
      },
      {
        id: "create_invoice",
        name: "Create Invoice",
        description: "Create a new invoice",
        parameters: {
          customer_id: "string",
          items: "array",
          due_date: "number?",
        },
      },
      {
        id: "refund_payment",
        name: "Refund Payment",
        description: "Refund a payment",
        parameters: {
          charge_id: "string",
          amount: "number?",
          reason: "string?",
        },
      },
    ],
    icon: "💳",
    documentationUrl: "https://stripe.com/docs/api",
  },

  webhook: {
    id: "webhook",
    displayName: "Webhook",
    authType: "webhook_signature",
    triggers: [
      {
        id: "http_request",
        name: "HTTP Request",
        description: "Triggered when an HTTP request is received",
        payload_schema: {
          method: "string",
          path: "string",
          headers: "object",
          body: "object",
          query_params: "object",
          timestamp: "number",
        },
      },
    ],
    actions: [
      {
        id: "call_webhook",
        name: "Call Webhook",
        description: "Send an HTTP request to a webhook URL",
        parameters: {
          url: "string",
          method: "string",
          headers: "object?",
          body: "object?",
          timeout: "number?",
        },
      },
    ],
    icon: "🪝",
    documentationUrl: "https://en.wikipedia.org/wiki/Webhook",
  },
};

// ============================================================================
// Registry Queries
// ============================================================================

export function getIntegration(id: string): Integration | undefined {
  return INTEGRATION_REGISTRY[id];
}

export function listIntegrations(): Integration[] {
  return Object.values(INTEGRATION_REGISTRY);
}

export function getIntegrationsByAuthType(
  authType: string
): Integration[] {
  return Object.values(INTEGRATION_REGISTRY).filter(
    (i) => i.authType === authType
  );
}

export function validateIntegrationReference(integration_id: string): boolean {
  return integration_id in INTEGRATION_REGISTRY;
}

export function validateIntegrationAction(
  integration_id: string,
  action_id: string
): boolean {
  const integration = getIntegration(integration_id);
  if (!integration) return false;
  return integration.actions.some((a) => a.id === action_id);
}

export function validateIntegrationTrigger(
  integration_id: string,
  trigger_id: string
): boolean {
  const integration = getIntegration(integration_id);
  if (!integration) return false;
  return integration.triggers.some((t) => t.id === trigger_id);
}
