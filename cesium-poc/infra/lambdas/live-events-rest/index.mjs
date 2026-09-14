import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const LIVE_EVENTS_TABLE = process.env.LIVE_EVENTS_TABLE
const CORS_HEADERS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' }

function determineSourceStatus(items) {
  if (!items || items.length === 0) {
    return { status: 'UNAVAILABLE', lastUpdated: null }
  }

  const mostRecent = items.reduce((latest, item) => {
    if (!item.lastUpdated) return latest
    if (!latest) return item.lastUpdated
    return new Date(item.lastUpdated) > new Date(latest) ? item.lastUpdated : latest
  }, null)

  if (!mostRecent) {
    return { status: 'UNAVAILABLE', lastUpdated: null }
  }

  const age = Date.now() - new Date(mostRecent).getTime()
  let status
  if (age < 90_000) {
    status = 'LIVE'
  } else if (age < 300_000) {
    status = 'STALE'
  } else {
    status = 'UNAVAILABLE'
  }

  return { status, lastUpdated: mostRecent }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET'

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' }
  if (method !== 'GET' && method !== 'HEAD') {
    return { statusCode: 405, headers: { ...CORS_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Only GET is supported' }) }
  }

  try {
    const now = Math.floor(Date.now() / 1000)
    const result = await ddb.send(new ScanCommand({
      TableName: LIVE_EVENTS_TABLE,
      FilterExpression: '#ttl > :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': now }
    }))
    const items = result.Items ?? []
    const events = items.map(({ ttl, ...rest }) => rest)  // strip DynamoDB TTL field
    const incidents = events.filter(e => e.type === 'INCIDENT')
    const closures  = events.filter(e => e.type === 'CLOSURE')
    const { status, lastUpdated } = determineSourceStatus(items)

    const payload = {
      source: 'FL511',
      sourceStatus: status,
      lastUpdated,
      lastSuccessfulUpdate: status !== 'UNAVAILABLE' ? lastUpdated : null,
      bufferMeters: 250,
      counts: { total: events.length, incidents: incidents.length, closures: closures.length },
      events,
    }

    const body = JSON.stringify(payload)
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: method === 'HEAD' ? '' : body
    }
  } catch (err) {
    console.error('live-events-rest error', err)
    return { statusCode: 503, headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'FL511', sourceStatus: 'UNAVAILABLE', lastUpdated: null, lastSuccessfulUpdate: null, bufferMeters: 250, counts: { total: 0, incidents: 0, closures: 0 }, events: [] }) }
  }
}
