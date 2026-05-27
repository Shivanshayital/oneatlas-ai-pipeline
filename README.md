# OneAtlas AI Pipeline

A production-grade multi-stage AI pipeline for converting natural language app descriptions into validated AppSpec objects. Built for the 72-hour internship trial task.

## Architecture Overview

```
INPUT: Natural Language Prompt
  ↓
┌─────────────────────────────────┐
│   Stage 1: Intent Extraction    │ → AppIntent
├─────────────────────────────────┤
│   Stage 2: Schema Generation    │ → DataSchema
├─────────────────────────────────┤
│   Stage 3: AppSpec Generation   │ → AppSpec
├─────────────────────────────────┤
│  Validation + Repair Loop       │
├─────────────────────────────────┤
│      SSE Event Streaming        │
└─────────────────────────────────┘
  ↓
OUTPUT: JobResult (Intent, Schema, Spec, RepairLogs)
```

## Project Structure

```
src/
├── app/                          # Next.js App Router
│   └── api/                      # API routes
├── backend/
│   ├── ai/
│   │   └── gateway.ts           # Multi-provider AI abstraction
│   ├── pipeline/
│   │   └── orchestrator.ts      # Pipeline orchestration logic
│   ├── validation/
│   │   └── engine.ts            # Zod-based validation
│   ├── repair/
│   │   └── engine.ts            # Repair strategies
│   ├── integrations/
│   │   └── registry.ts          # Integration definitions
│   ├── schemas/
│   │   └── index.ts             # Zod validation schemas
│   ├── types/
│   │   └── index.ts             # TypeScript type definitions
│   ├── utils/
│   │   └── helpers.ts           # Utility functions
│   ├── logging/
│   │   └── logger.ts            # Logging service
│   ├── routes/
│   │   └── index.ts             # API route documentation
│   └── config.ts                # Configuration management
├── components/                   # React components (minimal)
└── lib/                         # Client-side utilities
```

## Core Modules

### 1. **AI Gateway** (`src/backend/ai/gateway.ts`)
- Multi-provider abstraction supporting OpenAI, Groq, Gemini
- Stubs for Anthropic, Mistral, DeepSeek, OpenRouter
- Config-driven model routing (no hardcoding)
- Fallback mechanism for provider failures

### 2. **Pipeline Orchestrator** (`src/backend/pipeline/orchestrator.ts`)
- Runs 3-stage pipeline: Intent → Schema → Spec
- Calls validation after each stage
- Applies repair logic automatically
- Emits real-time events via listeners
- Tracks metrics (tokens, latency, repairs)

### 3. **Validation Engine** (`src/backend/validation/engine.ts`)
- Zod schemas for all data types
- Structured error reporting
- Semantic validation (e.g., entity references)
- Type-safe error handling

### 4. **Repair Engine** (`src/backend/repair/engine.ts`)
- **Structural Repair**: Fixes truncated JSON, missing braces
- **Field Repair**: Injects missing fields, fixes types
- **Consistency Repair**: Validates entity/integration references
- Logs all repairs with strategy and outcome

### 5. **Integration Registry** (`src/backend/integrations/registry.ts`)
- Fully implemented: Slack, Gmail, WhatsApp, Stripe, Webhook
- Each integration defines triggers and actions
- Registry validation helpers
- Easy to extend with new integrations

## Setup

### 1. Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your API keys:
```
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
GEMINI_API_KEY=AIza...
```

### 3. Run Development Server

```bash
npm run dev
# or
yarn dev
```

Visit `http://localhost:3000`

## API Endpoints

### POST /api/generate
Start a new app generation job.

**Request:**
```json
{
  "prompt": "Build a project management app with tasks, projects, and team collaboration"
}
```

**Response (202 Accepted):**
```json
{
  "job_id": "uuid-string"
}
```

### GET /api/generate/:jobId
Get job status and result.

**Response:**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "result": {
    "intent": { ... },
    "schema": { ... },
    "spec": { ... },
    "repairs_applied": [...]
  },
  "metrics": {
    "tokens": { "total_tokens": 5000, "estimated_cost": 0.12 },
    "latency": { "total_ms": 8500 }
  }
}
```

### GET /api/generate/:jobId/stream
Server-Sent Events stream for real-time progress.

**Events:**
```
event: stage_start
data: {"stage": "intent", "timestamp": "..."}

event: stage_complete
data: {"stage": "intent", "data": {...}}

event: generation_complete
data: {"jobId": "..."}
```

### GET /api/integrations
List all available integrations.

**Response:**
```json
{
  "integrations": [
    {
      "id": "slack",
      "displayName": "Slack",
      "authType": "oauth2",
      "triggers": [...],
      "actions": [...]
    },
    ...
  ]
}
```

## Data Flow Example

### Input
```
"I need a real-time notification system for my e-commerce store. 
It should track orders, send emails, and sync with Slack."
```

### Stage 1: Intent Extraction
```json
{
  "appName": "E-Commerce Notification System",
  "appType": "api",
  "features": ["order tracking", "email notifications", "Slack integration"],
  "entities": ["Order", "Notification", "Customer"],
  "integrations_requested": ["gmail", "slack"],
  "assumptions": ["Using PostgreSQL for persistence", "REST API"]
}
```

### Stage 2: Schema Generation
```json
{
  "schema_version": "1.0.0",
  "entities": [
    {
      "name": "Order",
      "tableName": "orders",
      "fields": [
        { "name": "id", "type": "uuid", "required": true },
        { "name": "tenantId", "type": "uuid", "required": true },
        { "name": "customer_id", "type": "uuid", "required": true },
        { "name": "status", "type": "enum", "enum_values": ["pending", "shipped", "delivered"] }
      ],
      "relations": [...]
    },
    ...
  ]
}
```

### Stage 3: AppSpec Generation
```json
{
  "metadata": {
    "app_name": "E-Commerce Notification System",
    "app_type": "api",
    "version": "1.0.0"
  },
  "pages": [...],
  "api_endpoints": [...],
  "workflows": [
    {
      "name": "send_order_notification",
      "trigger_type": "event",
      "trigger_entity": "Order",
      "steps": [
        { "action": "send_email", "integration_id": "gmail" },
        { "action": "send_message", "integration_id": "slack" }
      ]
    }
  ]
}
```

## Model Routing

Models are configured centrally and not hardcoded in stage implementations:

```typescript
export const MODEL_ROUTING = {
  intent: {
    primary: "groq/llama-3.1-70b-versatile",   // Fast for intent
    fallback: "openai/gpt-4o-mini"
  },
  schema: {
    primary: "openai/gpt-4o",                  // Accurate for schema
    fallback: "gemini/gemini-2.0-flash"
  },
  spec: {
    primary: "openai/gpt-4o",                  // Comprehensive for spec
    fallback: "groq/llama-3.1-70b-versatile"
  }
};
```

## Key Design Principles

✅ **No `any` types** — Strict TypeScript everywhere  
✅ **Type-safe validation** — Zod schemas for all inputs  
✅ **Modular architecture** — Each stage isolated and testable  
✅ **Repair-first approach** — Automatic recovery from failures  
✅ **Config-driven** — Models and integrations centrally managed  
✅ **Minimal frontend** — Focus on backend reliability  
✅ **Real-time progress** — SSE for client visibility  
✅ **Comprehensive logging** — Full audit trail  

## Repair Strategies

The repair engine automatically fixes:

1. **Malformed JSON**
   - Adds missing closing braces `}`
   - Removes markdown code fences
   - Extracts JSON from wrapped text

2. **Missing Fields**
   - Injects required fields with sensible defaults
   - Converts wrong types (string → array)

3. **Broken References**
   - Validates entities exist in schema
   - Validates integrations exist in registry
   - Maps invalid references to available entities

Example repair log:
```json
{
  "timestamp": "2026-05-27T10:30:45.123Z",
  "stage": "spec",
  "strategy": "structural_repair",
  "error": "Truncated JSON",
  "action": "Added missing braces: }} ",
  "outcome": "success"
}
```

## Integrations

### Available

- **Slack** — Messaging, reactions, threads
- **Gmail** — Email send, labels, archive
- **WhatsApp** — SMS, templates, media
- **Stripe** — Payments, invoices, refunds
- **Webhook** — Generic HTTP triggers/actions

### Stub (Future)

- Anthropic
- Mistral
- DeepSeek
- OpenRouter

## Development Checklist

- [x] Complete folder structure
- [x] TypeScript types and Zod schemas
- [x] AI Gateway (OpenAI, Groq, Gemini)
- [x] Pipeline Orchestrator
- [x] Validation Engine
- [x] Repair Engine
- [x] Integration Registry
- [x] Logging Service
- [ ] Next.js API routes (implement in Step 2)
- [ ] React components (keep minimal)
- [ ] Frontend dashboard
- [ ] Database integration (optional)
- [ ] Docker setup

## Next Steps

1. **Implement API Routes** — Create Next.js route handlers for /api/generate
2. **Frontend Dashboard** — Build minimal React components for progress/results
3. **Testing** — Add unit tests for repair engine and validation
4. **Deployment** — Docker + environment setup

## Performance Targets

- Intent extraction: < 2s
- Schema generation: < 3s
- Spec generation: < 5s
- Total pipeline: < 15s (with model latency)

## Error Handling

All errors are structured and logged:

```typescript
interface ValidationError {
  field: string;
  message: string;
  code: string;
}
```

Never thrown raw exceptions. Always return structured errors.

## Contributing

Follow TypeScript strict mode. No `any` types. Keep modules isolated.

## License

Internal use only — Internship project.
