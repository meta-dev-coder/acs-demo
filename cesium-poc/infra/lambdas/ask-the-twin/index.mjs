// I-595 Digital Twin — "Ask the Twin" Lambda handler

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const CORS_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
};

const smClient = new SecretsManagerClient({ region: process.env.ANTHROPIC_SECRET_REGION });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let cachedApiKey = null;

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.ANTHROPIC_SECRET_ARN });
  const result = await smClient.send(cmd);
  cachedApiKey = JSON.parse(result.SecretString).api_key;
  return cachedApiKey;
}

async function getLiveEvents() {
  const now = Math.floor(Date.now() / 1000);
  const result = await dynamo.send(
    new ScanCommand({
      TableName: process.env.LIVE_EVENTS_TABLE,
      FilterExpression: "attribute_not_exists(#ttl) OR #ttl > :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":now": now },
    })
  );
  return result.Items || [];
}

function buildZoneB(events) {
  if (!events.length) {
    return "CURRENT LIVE EVENTS (as of query time):\nNo active events on record.";
  }
  const lines = events
    .slice(0, 10)
    .map((e) => `- [${e.type ?? "event"}] on ${e.road ?? "I-595"} near ${e.location ?? "unknown"}: ${e.description ?? ""} (since ${e.startTime ?? "unknown"})`)
    .join("\n");
  return `CURRENT LIVE EVENTS (as of query time):\n${lines}`;
}

const ZONE_A = `You are a knowledgeable assistant for the I-595 Digital Twin, an AWS-powered visualization of the I-595 Corridor in Broward County, Florida.

CORRIDOR OVERVIEW:
- I-595 runs east-west through Broward County, connecting I-75 (west) to US-1/Port Everglades (east)
- Total length: ~11 miles (17.7 km)
- The corridor includes: I-595 Express (reversible managed lanes, center), mainline EB/WB lanes, and 9 diverging diamond interchanges
- Express lanes are reversible: inbound (westbound) in the AM peak, outbound (eastbound) in the PM peak
- Major interchanges: I-75/SR-826, University Dr, Nob Hill Rd, Hiatus Rd, Pine Island Rd, SR-7/US-441, Flamingo Rd, 136th Ave, Florida Turnpike, I-95, US-1
- The digital twin shows: FDOT traffic segments (EB/WB), express lanes, CCTV cameras, traffic signals, ramps/connectors, bridge structures, and real-time FL511 incidents

OPERATIONAL CONTEXT:
- Data comes from FDOT (Florida Department of Transportation) and FL511
- CCTV cameras provide live JPEG snapshots from DIVAS (Digital Video Alerting System)
- Live events include: incidents, road closures, congestion alerts, work zones
- The twin is hosted on AWS: CloudFront + S3 + Lambda + DynamoDB + EventBridge`;

const ZONE_C = `OUTPUT RULES: raw JSON only — no markdown, no code fences, no backticks, no preamble, no explanation. Your entire response must be parseable by JSON.parse(). Schema:
{
  "answer": "string — plain English answer, max 3 sentences",
  "action": {
    "type": "fly_to | open_camera | show_event | none",
    "entity_id": "string or null",
    "coordinates": { "lon": number, "lat": number } or null
  },
  "confidence": "high | medium | low",
  "sources": ["static_knowledge", "live_events"]
}

ACTION RULES:
- Camera questions → type: "open_camera", coordinates: nearest known camera location on I-595
- Incident/event questions → type: "show_event", coordinates of the event location
- Location/area questions → type: "fly_to", coordinates of that location
- General questions → type: "none", coordinates: null
- I-595 approximate camera zone coordinates: western end lon=-80.38 lat=26.07, Turnpike lon=-80.254 lat=26.071, I-95 lon=-80.127 lat=26.073, eastern end lon=-80.10 lat=26.073`;

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
      body: "",
    };
  }

  let question;
  try {
    const body = JSON.parse(event.body ?? "{}");
    question = body.question;
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing required field: question" }) };
  }

  if (question.length > 512) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "question exceeds 512 characters" }) };
  }

  try {
    const [apiKey, events] = await Promise.all([getApiKey(), getLiveEvents()]);

    const systemPrompt = [ZONE_A, buildZoneB(events), ZONE_C].join("\n\n");

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Anthropic API error ${anthropicRes.status}: ${errText}`);
    }

    const anthropicData = await anthropicRes.json();
    const rawText = anthropicData.content?.[0]?.text ?? "";

    // Strip markdown code fences (```json ... ``` or ``` ... ```) before parsing
    const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // Last resort: extract first {...} block from the text
      const match = stripped.match(/\{[\s\S]*\}/);
      try {
        parsed = match ? JSON.parse(match[0]) : null;
      } catch { parsed = null; }

      if (!parsed) {
        parsed = {
          answer: stripped || rawText,
          action: { type: "none", entity_id: null, coordinates: null },
          confidence: "low",
          sources: ["static_knowledge"],
        };
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message ?? "Internal server error" }),
    };
  }
};
