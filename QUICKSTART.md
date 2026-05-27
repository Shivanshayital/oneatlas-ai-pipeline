# Quick Start Guide

## 5-Minute Setup

### 1. Clone & Install

```bash
cd oneatlas-ai-pipeline
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
# Edit .env.local with your API keys
```

**Required API Keys:**
- `OPENAI_API_KEY` - [Get from platform.openai.com](https://platform.openai.com)
- `GROQ_API_KEY` - [Get from console.groq.com](https://console.groq.com)
- `GEMINI_API_KEY` - [Get from aistudio.google.com](https://aistudio.google.com)

### 3. Run Development Server

```bash
npm run dev
```

Visit `http://localhost:3000`

---

## Project Structure at a Glance

```
✓ DONE:
├── Core Types & Interfaces        (backend/types/)
├── Zod Validation Schemas         (backend/schemas/)
├── AI Gateway (Multi-provider)    (backend/ai/gateway.ts)
├── Pipeline Orchestrator          (backend/pipeline/orchestrator.ts)
├── Validation Engine              (backend/validation/engine.ts)
├── Repair Engine (3 strategies)   (backend/repair/engine.ts)
├── Integration Registry (5 APIs)  (backend/integrations/registry.ts)
├── Logger Service                 (backend/logging/logger.ts)
├── Config Management              (backend/config.ts)
└── Build Configuration            (tsconfig, next.config, tailwind, etc.)

TODO:
├── Next.js API Routes             (src/app/api/)
├── React Frontend Components      (src/components/)
├── Database Integration (optional)
└── Unit Tests
```

---

## Using the Pipeline

### Direct Usage (Backend)

```typescript
import { loadConfig, initializePipeline } from "@/backend/config";

const config = loadConfig();
const orchestrator = initializePipeline(config);

// Start generation
const jobId = await orchestrator.processPrompt(
  "Build a task management app with teams and real-time updates"
);

// Get result
const job = orchestrator.getJob(jobId);
const result = job?.result; // { intent, schema, spec, repairs_applied }

// Stream events
orchestrator.onEvent((event) => {
  console.log(`${event.type} on ${event.stage}`);
});
```

### API Usage (HTTP)

```bash
# Start job
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Build a CRM system"}'

# Response: {"job_id":"uuid"}

# Get status
curl http://localhost:3000/api/generate/uuid

# Stream events
curl http://localhost:3000/api/generate/uuid/stream
```

---

## Key Modules Reference

### AppIntent Example

```json
{
  "appName": "Task Manager",
  "appType": "web",
  "features": ["create tasks", "assign to teams", "notifications"],
  "entities": ["Task", "Team", "User"],
  "integrations_requested": ["slack", "gmail"],
  "assumptions": ["PostgreSQL backend", "REST API"]
}
```

### DataSchema Example

```json
{
  "schema_version": "1.0.0",
  "entities": [
    {
      "name": "Task",
      "tableName": "tasks",
      "fields": [
        { "name": "id", "type": "uuid", "required": true },
        { "name": "tenantId", "type": "uuid", "required": true },
        { "name": "title", "type": "string", "required": true }
      ]
    }
  ]
}
```

### AppSpec Example

```json
{
  "metadata": {
    "app_name": "Task Manager",
    "app_type": "web",
    "version": "1.0.0"
  },
  "pages": [
    {
      "name": "tasks_list",
      "path": "/tasks",
      "title": "Tasks",
      "requires_auth": true,
      "components": ["TaskList", "Filter", "Sort"]
    }
  ],
  "api_endpoints": [
    {
      "path": "/api/tasks",
      "method": "GET",
      "entity": "Task",
      "auth_required": true,
      "response_type": "Task[]"
    }
  ]
}
```

---

## Validation & Repair

### How Validation Works

```typescript
import { validationEngine } from "@/backend/validation/engine";

const result = validationEngine.validateAppIntent(data);

if (!result.valid) {
  console.log(result.errors);
  // [{ field: "appName", message: "Required", code: "too_small" }]
}
```

### How Repair Works

```typescript
import { repairEngine } from "@/backend/repair/engine";

// Structural repair (fix JSON)
const { content, logs } = repairEngine.repairStructure("intent", malformedJson);

// Field repair (inject defaults)
const { data, logs } = repairEngine.repairFields("intent", data, requiredFields);

// Consistency repair (validate references)
const { data, logs } = repairEngine.repairConsistency("spec", data, schema);
```

---

## Integrations Reference

### Available Integrations

| Integration | Auth | Triggers | Actions |
|---|---|---|---|
| **Slack** | OAuth2 | message_received, reaction_added | send_message, create_thread, add_reaction |
| **Gmail** | OAuth2 | email_received, email_labeled | send_email, apply_label, archive_email |
| **WhatsApp** | API Key | message_received, status_changed | send_message, send_template, send_media |
| **Stripe** | API Key | payment_succeeded, invoice_paid | create_payment, create_invoice, refund_payment |
| **Webhook** | Signature | http_request | call_webhook |

### Add to App

```json
{
  "integration_hooks": [
    {
      "integration_id": "slack",
      "trigger": "message_received",
      "action": "send_message",
      "entity_mapping": {
        "user_id": "owner_id",
        "message": "notification_text"
      }
    }
  ]
}
```

---

## AI Model Routing

Models are centrally configured and **not hardcoded** in stage logic:

```typescript
// src/backend/ai/gateway.ts
export const MODEL_ROUTING = {
  intent: {
    primary: "groq/llama-3.1-70b-versatile",    // Fast & cheap
    fallback: "openai/gpt-4o-mini"
  },
  schema: {
    primary: "openai/gpt-4o",                   // Accurate
    fallback: "gemini/gemini-2.0-flash"
  },
  spec: {
    primary: "openai/gpt-4o",                   // Comprehensive
    fallback: "groq/llama-3.1-70b-versatile"
  }
};
```

To change models, edit config and restart. No code changes needed.

---

## Common Tasks

### Add a New Provider

1. Extend `MultiProviderGateway` in `src/backend/ai/gateway.ts`
2. Implement provider class (OpenAI, Groq, Gemini patterns)
3. Update `MODEL_ROUTING` config
4. Update `.env.example` with API key

### Add a New Integration

1. Add entry to `INTEGRATION_REGISTRY` in `src/backend/integrations/registry.ts`
2. Define triggers and actions
3. Users can now reference it in AppSpec workflows
4. Validation will check for valid integration IDs

### Fix a Validation Error

1. Check the error message and field in validation result
2. Repair engine will auto-fix if possible
3. If not, error bubbles up with details
4. Add custom repair logic if needed

---

## Testing the Pipeline

### Manual Test

```typescript
// Copy to src/test.ts and run with npx ts-node

import { loadConfig, initializePipeline } from "@/backend/config";

const config = loadConfig();
const orchestrator = initializePipeline(config);

orchestrator.onEvent((event) => {
  console.log(`[${event.stage}] ${event.type}`);
});

const jobId = await orchestrator.processPrompt(
  "Build a social media app with posts, comments, and likes"
);

const result = orchestrator.getJob(jobId);
console.log("Final result:", JSON.stringify(result, null, 2));
```

---

## Performance Tips

- **Groq models** (llama) are 2-3x faster for intent extraction
- **OpenAI GPT-4o** provides best accuracy for schema/spec
- **Fallback chains** prevent total failure
- **Repair engine** avoids expensive retries
- Typical pipeline: **8-12 seconds** end-to-end

---

## Debugging

### Enable Verbose Logging

```typescript
import { logger } from "@/backend/logging/logger";

logger.debug("Starting pipeline", { prompt: input });
logger.info("Stage complete", { stage: "intent", duration: 2000 });
logger.error("Validation failed", error, { data: result });

// Export logs
const logs = logger.export();
```

### Inspect Repairs

```typescript
const { logs } = repairEngine.repairFields("intent", data, required);

logs.forEach((log) => {
  console.log(`${log.strategy}: ${log.error} → ${log.action} [${log.outcome}]`);
});
```

---

## Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
GEMINI_API_KEY=AIza...

# Optional
NODE_ENV=development          # or production
PORT=3000

# Future Stubs
# ANTHROPIC_API_KEY=...
# MISTRAL_API_KEY=...
# DEEPSEEK_API_KEY=...
# OPENROUTER_API_KEY=...
```

---

## TypeScript Strict Mode

Everything runs in strict mode (`tsconfig.json`):

- ✅ `noImplicitAny` — No `any` types
- ✅ `strictNullChecks` — Null safety
- ✅ `strictFunctionTypes` — Function safety
- ✅ `noUnusedLocals` — Catch dead code
- ✅ `noImplicitReturns` — All paths return

**Result:** Type-safe, refactor-friendly codebase

---

## Resources

- **OpenAI Docs:** https://platform.openai.com/docs
- **Groq Docs:** https://console.groq.com/docs
- **Gemini Docs:** https://ai.google.dev/docs
- **Next.js:** https://nextjs.org/docs
- **Zod:** https://zod.dev
- **TypeScript:** https://www.typescriptlang.org/docs

---

## Support

For issues:
1. Check `ARCHITECTURE.md` for system overview
2. Review `README.md` for API details
3. Check repair logs for error source
4. Enable debug logging
5. Verify environment variables are set

---

**Last Updated:** May 27, 2026
**Version:** 1.0.0
**Status:** Ready for development
