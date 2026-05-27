// ============================================================================
// ARCHITECTURE OVERVIEW
// ============================================================================

/*
This document explains the complete architecture and how all modules
work together to create a production-grade AI pipeline.

SYSTEM FLOW
───────────────────────────────────────────────────────────────────────────

1. CLIENT REQUEST
   └─> POST /api/generate
       { prompt: "Build a task management app..." }

2. ROUTE HANDLER (src/app/api/generate/route.ts)
   ├─> Validate input (length, format)
   ├─> Load configuration from environment
   ├─> Initialize PipelineOrchestrator
   └─> Return jobId with 202 status

3. PIPELINE ORCHESTRATOR (src/backend/pipeline/orchestrator.ts)
   Executes the 3-stage pipeline:
   
   STAGE 1: INTENT EXTRACTION
   ├─> Initialize AI Gateway with Groq/GPT routing
   ├─> Send system prompt + user prompt
   ├─> Receive JSON response from AI
   ├─> Repair structure (fix truncated JSON, brackets)
   ├─> Parse JSON
   ├─> Repair fields (inject missing defaults)
   ├─> Validate with Zod schema
   └─> Emit "stage_complete" event
   
   STAGE 2: SCHEMA GENERATION
   ├─> Initialize AI Gateway with OpenAI/Gemini routing
   ├─> Send intent summary + system prompt
   ├─> Ensure every entity has "tenantId" field
   ├─> Repair structure
   ├─> Parse JSON
   ├─> Validate with Zod schema (semantic validation)
   └─> Emit "stage_complete" event
   
   STAGE 3: APPSPEC GENERATION
   ├─> Initialize AI Gateway with OpenAI routing
   ├─> Send schema + system prompt
   ├─> Populate metadata and data_schema
   ├─> Repair structure
   ├─> Repair consistency (validate entity/integration refs)
   ├─> Validate with Zod schema
   └─> Emit "generation_complete" event

4. VALIDATION FLOW (for each stage)
   ├─> ValidationEngine.validateX()
   ├─> Zod schema.parse()
   ├─> If valid: return { valid: true }
   ├─> If invalid: return { valid: false, errors: [] }
   └─> Semantic validation (entity references, etc.)

5. REPAIR FLOW (on validation failure)
   ├─> Identify error type
   ├─> Apply repair strategy:
   │   ├─ STRUCTURAL_REPAIR
   │   │  ├─ Fix truncated JSON
   │   │  ├─ Add missing braces/brackets
   │   │  └─ Remove markdown fences
   │   ├─ FIELD_REPAIR
   │   │  ├─ Inject missing required fields
   │   │  └─ Fix type mismatches (string → array)
   │   └─ CONSISTENCY_REPAIR
   │      ├─ Validate entity references
   │      ├─ Validate integration references
   │      └─ Remove/remap invalid refs
   ├─> Log repair attempt
   └─> Re-validate

6. SSE STREAMING
   ├─> Client connects to /api/generate/{jobId}/stream
   ├─> Server registers event listener on orchestrator
   ├─> For each event:
   │   ├─ Format as SSE message
   │   ├─ Send to client
   │   └─ Client updates UI
   └─> Connection closes on generation_complete

7. RESULT STORAGE & RETRIEVAL
   └─> GET /api/generate/{jobId}
       ├─ Retrieve cached job from memory
       ├─ Return result + metrics
       └─ Client displays AppSpec


DEPLOYMENT ARCHITECTURE
───────────────────────────────────────────────────────────────────────────

┌─────────────────────────────────────────────────────────────┐
│                        Next.js (Node.js)                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ API Routes (src/app/api/)                            │  │
│  │  - POST /api/generate                               │  │
│  │  - GET /api/generate/:jobId                         │  │
│  │  - GET /api/generate/:jobId/stream (SSE)           │  │
│  │  - GET /api/integrations                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                        ↓                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Backend Services (src/backend/)                      │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────────┐ │  │
│  │  │ PipelineOrchestrator                           │ │  │
│  │  │ - Orchestrates 3-stage pipeline                │ │  │
│  │  │ - Emits events                                 │ │  │
│  │  │ - Tracks metrics                               │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  │                 ↓                                    │  │
│  │  ┌────────────────────────────────────────────────┐ │  │
│  │  │ Stage Implementations (orchestrator.ts)        │ │  │
│  │  │ - Intent Extraction                            │ │  │
│  │  │ - Schema Generation                            │ │  │
│  │  │ - AppSpec Generation                           │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  │                 ↓                                    │  │
│  │  ┌────────────────────────────────────────────────┐ │  │
│  │  │ Support Layers                                 │ │  │
│  │  │                                                │ │  │
│  │  │  AIGateway                                     │ │  │
│  │  │  ├─ OpenAI (gpt-4o, gpt-4o-mini)            │ │  │
│  │  │  ├─ Groq (llama-3.1)                         │ │  │
│  │  │  └─ Gemini (gemini-2.0-flash)                │ │  │
│  │  │                                                │ │  │
│  │  │  ValidationEngine                             │ │  │
│  │  │  ├─ Zod schemas                               │ │  │
│  │  │  └─ Semantic validation                       │ │  │
│  │  │                                                │ │  │
│  │  │  RepairEngine                                 │ │  │
│  │  │  ├─ Structural repair                         │ │  │
│  │  │  ├─ Field repair                              │ │  │
│  │  │  └─ Consistency repair                        │ │  │
│  │  │                                                │ │  │
│  │  │  IntegrationRegistry                          │ │  │
│  │  │  ├─ Slack                                     │ │  │
│  │  │  ├─ Gmail                                     │ │  │
│  │  │  ├─ WhatsApp                                  │ │  │
│  │  │  ├─ Stripe                                    │ │  │
│  │  │  └─ Webhook                                  │ │  │
│  │  │                                                │ │  │
│  │  │  Logger & Utils                               │ │  │
│  │  │  └─ Logging, helpers, token costs             │ │  │
│  │  │                                                │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  │                                                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Frontend (React Components - Minimal)               │  │
│  │  - Prompt input                                     │  │
│  │  - Progress panel (SSE updates)                    │  │
│  │  - AppSpec viewer (JSON/formatted)                │  │
│  │  - Integration browser                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         ↓                                    ↓
    ┌─────────────┐                   ┌──────────────┐
    │ AI Providers│                   │ (Optional)   │
    │ - OpenAI    │                   │ - Database   │
    │ - Groq      │                   │ - Cache      │
    │ - Gemini    │                   │ - Analytics  │
    └─────────────┘                   └──────────────┘


TYPE SAFETY & VALIDATION ARCHITECTURE
───────────────────────────────────────────────────────────────────────────

┌─────────────────────────────────────────┐
│      TypeScript Strict Mode On          │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────┐  │
│  │ Types (backend/types/index.ts)  │  │
│  │                                 │  │
│  │ • AppIntent                     │  │
│  │ • DataSchema                    │  │
│  │ • AppSpec                       │  │
│  │ • StageEvent                    │  │
│  │ • ... and 20+ core types        │  │
│  │                                 │  │
│  └────────────────┬────────────────┘  │
│                   ↓                    │
│  ┌─────────────────────────────────┐  │
│  │ Zod Schemas (backend/schemas/)  │  │
│  │                                 │  │
│  │ • AppIntentSchema               │  │
│  │ • DataSchemaSchema              │  │
│  │ • AppSpecSchema                 │  │
│  │ • DataEntitySchema              │  │
│  │ • ... 10+ validation schemas    │  │
│  │                                 │  │
│  │ Features:                       │  │
│  │ ✓ Type inference (z.infer)      │  │
│  │ ✓ Custom refinements            │  │
│  │ ✓ Composable validators         │  │
│  │ ✓ Detailed error reporting      │  │
│  │                                 │  │
│  └────────────────┬────────────────┘  │
│                   ↓                    │
│  ┌─────────────────────────────────┐  │
│  │ Runtime Validation              │  │
│  │                                 │  │
│  │ ValidationEngine.validateX()    │  │
│  │  → Zod parse()                  │  │
│  │  → Catch ZodError               │  │
│  │  → Return structured errors     │  │
│  │                                 │  │
│  │ No throwing exceptions!         │  │
│  │ All errors returned as data     │  │
│  │                                 │  │
│  └─────────────────────────────────┘  │
│                                         │
│  Result: Type-safe end-to-end         │
│  ✓ Compile-time checks (TypeScript)   │
│  ✓ Runtime checks (Zod)                │
│  ✓ No 'any' types anywhere             │
│                                         │
└─────────────────────────────────────────┘


ERROR RECOVERY STRATEGY
───────────────────────────────────────────────────────────────────────────

Stage → Generate → Parse → Validate
  ↓       ↑      ↑      ↑
  └──────────────┴──────┘
     If error, repair

Repair Strategy Selection:

1. JSON Parse Error?
   → Try STRUCTURAL_REPAIR
   → Fix braces, remove markdown
   → Re-parse

2. Validation Error (Schema Mismatch)?
   → Try FIELD_REPAIR
   → Inject defaults, fix types
   → Re-validate

3. Consistency Error (Invalid References)?
   → Try CONSISTENCY_REPAIR
   → Map to valid entity/integration
   → Re-validate

4. Still Failing?
   → Log repair attempt (failed outcome)
   → Continue with best-effort data
   → Or trigger fallback model


METRICS & TRACKING
───────────────────────────────────────────────────────────────────────────

For each job:

TokenMetrics:
  • input_tokens: Tokens consumed by all AI calls
  • output_tokens: Tokens generated by AI
  • total_tokens: Sum
  • estimated_cost: USD calculated from token count

LatencyMetrics:
  • intent_stage_ms: Time for Stage 1
  • schema_stage_ms: Time for Stage 2
  • spec_stage_ms: Time for Stage 3
  • total_ms: Total pipeline time

PipelineMetrics:
  • tokens: TokenMetrics
  • latency: LatencyMetrics
  • repair_attempts: Number of repairs tried
  • successful_repairs: Number of successful repairs


EXTENSIBILITY POINTS
───────────────────────────────────────────────────────────────────────────

1. Add New AI Provider:
   → Extend src/backend/ai/gateway.ts
   → Implement send() method
   → Update MODEL_ROUTING config

2. Add New Integration:
   → Add entry to INTEGRATION_REGISTRY
   → Define triggers and actions
   → Queries automatically validate

3. Add New Validation Rule:
   → Extend Zod schema in schemas/index.ts
   → Add semantic check in ValidationEngine
   → Repair strategy applies automatically

4. Add New Repair Strategy:
   → Implement in RepairEngine
   → Add detection logic
   → Log and track outcome


DEPLOYMENT CHECKLIST
───────────────────────────────────────────────────────────────────────────

[ ] Environment Variables
    [ ] OPENAI_API_KEY
    [ ] GROQ_API_KEY
    [ ] GEMINI_API_KEY
    [ ] NODE_ENV=production
    [ ] PORT configured

[ ] Database (optional)
    [ ] PostgreSQL or compatible
    [ ] Jobs table schema
    [ ] Metrics table schema
    [ ] Repair logs table

[ ] Docker
    [ ] Dockerfile for container
    [ ] docker-compose for local dev
    [ ] .dockerignore configured

[ ] Monitoring
    [ ] Error tracking (Sentry optional)
    [ ] Logger configured
    [ ] Metrics endpoint
    [ ] Health check endpoint

[ ] Performance
    [ ] Model timeout configured
    [ ] Memory limits set
    [ ] Rate limiting added
    [ ] Response caching considered


NEXT PHASE ITEMS
───────────────────────────────────────────────────────────────────────────

1. IMPLEMENT REMAINING ROUTES
   - GET /api/generate/:jobId
   - GET /api/generate/:jobId/stream (SSE)
   - GET /api/integrations
   - POST /api/generate/:jobId/repair

2. BUILD FRONTEND
   - Prompt input component
   - Stage progress display
   - Result viewer (AppSpec renderer)
   - Integration browser

3. ADD PERSISTENCE
   - Store jobs in database
   - Cache generated AppSpecs
   - Track repair history

4. TESTING
   - Unit tests for repair engine
   - Integration tests for pipeline
   - End-to-end tests

5. OPTIMIZATION
   - Parallel stage execution (where safe)
   - Result caching
   - Token optimization

*/
