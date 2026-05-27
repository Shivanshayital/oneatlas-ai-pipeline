import { jobStore } from "@/backend/store/job-store";
import { PipelineExecutor } from "@/backend/pipeline/executor";
import { AIGateway } from "@/backend/ai/gateway";
import { AIRequest, AIResponse } from "@/backend/types";

class MockGateway implements AIGateway {
  private nextResponses: AIResponse[];

  constructor(responses: AIResponse[]) {
    this.nextResponses = responses;
  }

  validateProvider(): boolean {
    return true;
  }

  getAvailableModels(): string[] {
    return [];
  }

  async send(_request: AIRequest): Promise<AIResponse> {
    if (this.nextResponses.length === 0) {
      throw new Error("No mock response configured");
    }

    return this.nextResponses.shift() as AIResponse;
  }
}

function createMockResponse(content: string): AIResponse {
  return {
    content,
    model: "gpt-4o-mini",
    provider: "openai",
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    latency_ms: 10,
  };
}

describe("Failure simulation suite", () => {
  beforeEach(() => {
    // No explicit reset required for the singleton store, distinct job IDs are used.
  });

  it("recovers from malformed JSON, missing fields, and invalid integration references", async () => {
    const responses = [
      createMockResponse("```json\n{\n  \"appName\": \"Recovery App\",\n  \"appType\": \"web\",\n  \"features\": [\"dashboard\"],\n  \"entities\": [\"Customer\"],\n  \"integrations_requested\": [\"slack\"],\n  \"assumptions\": [\"users are internal\"]\n```"),
      createMockResponse("{\n  \"schema_version\": \"1.0.0\",\n  \"entities\": [\n    {\n      \"name\": \"Customer\",\n      \"tableName\": \"customers\",\n      \"fields\": [\n        {\"name\": \"id\", \"type\": \"uuid\", \"required\": true},\n      ],\n      \"relations\": []\n    }\n  ]\n"),
      createMockResponse("{\n  \"metadata\": {\n    \"app_name\": \"Recovery App\",\n    \"app_type\": \"web\",\n    \"version\": \"1.0.0\",\n    \"created_at\": \"2026-05-27T00:00:00.000Z\"\n  },\n  \"data_schema\": {\n    \"schema_version\": \"1.0.0\",\n    \"entities\": [\n      {\n        \"name\": \"Customer\",\n        \"tableName\": \"customers\",\n        \"fields\": [\n          {\"name\": \"id\", \"type\": \"uuid\", \"required\": true},\n          {\"name\": \"tenantId\", \"type\": \"uuid\", \"required\": true}\n        ],\n        \"relations\": []\n      }\n    ]\n  },\n  \"pages\": [\n    {\n      \"name\": \"home\",\n      \"path\": \"/\",\n      \"title\": \"Home\",\n      \"requires_auth\": false,\n      \"components\": [\"dashboard\"]\n    }\n  ],\n  \"api_endpoints\": [\n    {\n      \"path\": \"/api/customers\",\n      \"method\": \"GET\",\n      \"entity\": \"Customer\",\n      \"auth_required\": false,\n      \"response_type\": \"json\"\n    }\n  ],\n  \"auth_rules\": [],\n  \"integration_hooks\": [\n    {\n      \"integration_id\": \"slack\",\n      \"trigger\": \"message\",\n      \"action\": \"invalid_action\",\n      \"entity_mapping\": {}\n    }\n  ],\n  \"workflows\": [\n    {\n      \"name\": \"Notify\",\n      \"trigger_type\": \"event\",\n      \"trigger_entity\": \"Customer\",\n      \"steps\": [\n        {\n          \"action\": \"invalid_action\",\n          \"integration_id\": \"slack\"\n        }\n      ]\n    }\n  ],\n  \"assumptions\": []\n}"),
    ];

    const gateway = new MockGateway(responses);
    const executor = new PipelineExecutor(gateway);
    const jobId = `test-${Date.now()}-recovery`;

    jobStore.createJob(jobId, "Run recovery scenario");

    await expect(executor.executePipeline(jobId, "Run recovery scenario")).resolves.toBeUndefined();

    const jobState = jobStore.getJob(jobId);
    expect(jobState).toBeDefined();
    expect(jobState?.job.status).toBe("completed");
    expect(jobState?.repairs.length).toBeGreaterThan(0);
    expect(jobState?.provider_history.length).toBeGreaterThanOrEqual(3);
    expect(jobState?.retry_history.length).toBeGreaterThanOrEqual(0);
  });

  it("fails gracefully when pipeline output is unrecoverable", async () => {
    const responses = [
      createMockResponse("{\"appName\":\"Fail App\",\"appType\":\"web\",\"features\":[\"dashboard\"],\"entities\":[\"User\"],\"integrations_requested\":[\"slack\"],\"assumptions\":[\"none\"]}"),
      createMockResponse("{\"schema_version\": \"1.0.0\", \"entities\": []}"),
      createMockResponse("{\"metadata\": {\"app_name\": \"Fail App\", \"app_type\": \"web\", \"version\": \"1.0.0\", \"created_at\": \"2026-05-27T00:00:00.000Z\"}, \"data_schema\": {\"schema_version\": \"1.0.0\", \"entities\": []}, \"pages\": [], \"api_endpoints\": [], \"auth_rules\": [], \"integration_hooks\": [], \"workflows\": [], \"assumptions\": []}"),
    ];

    const gateway = new MockGateway(responses);
    const executor = new PipelineExecutor(gateway);
    const jobId = `test-${Date.now()}-failure`;

    jobStore.createJob(jobId, "Run unrecoverable failure scenario");

    await expect(executor.executePipeline(jobId, "Run unrecoverable failure scenario")).rejects.toBeDefined();

    const jobState = jobStore.getJob(jobId);
    expect(jobState).toBeDefined();
    expect(jobState?.job.status).toBe("failed");
    expect(jobState?.events.some((event) => event.type === "stage_failed")).toBe(true);
    expect(jobState?.validation_snapshots.length).toBeGreaterThan(0);
  });
});
