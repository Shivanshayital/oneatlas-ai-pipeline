import { NextRequest, NextResponse } from "next/server";
import { listIntegrations } from "@/backend/integrations/registry";
import { logger } from "@/backend/logging/logger";

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const integrations = listIntegrations();

    return NextResponse.json({
      count: integrations.length,
      integrations,
    });
  } catch (error) {
    logger.error("GET /api/integrations failed", error as Error);
    return NextResponse.json(
      { error: "Failed to retrieve integrations" },
      { status: 500 }
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
