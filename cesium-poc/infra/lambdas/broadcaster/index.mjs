import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const mgmt = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_API_ENDPOINT })
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE

export const handler = async (event) => {
  const { added = [], removed = [], updated = [], timestamp } = event.detail ?? {}

  // Get active connections
  const now = Math.floor(Date.now() / 1000)
  const result = await ddb.send(new ScanCommand({
    TableName: CONNECTIONS_TABLE,
    ProjectionExpression: 'connectionId',
    FilterExpression: '#ttl > :now',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':now': now }
  }))
  const connections = result.Items ?? []
  if (!connections.length) { console.log('no active connections'); return }

  const message = Buffer.from(JSON.stringify({ type: 'events-changed', added, removed, updated, timestamp }))
  let sent = 0, cleaned = 0

  await Promise.allSettled(connections.map(async ({ connectionId }) => {
    try {
      await mgmt.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: message }))
      sent++
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 410 || err.name === 'GoneException') {
        await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }))
        cleaned++
      } else {
        console.error('broadcast error for', connectionId, err.message)
      }
    }
  }))

  console.log('Broadcasted to %d/%d connections (%d stale cleaned)', sent, connections.length, cleaned)
}
