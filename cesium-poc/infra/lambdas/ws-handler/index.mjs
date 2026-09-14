import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE
const LIVE_EVENTS_TABLE = process.env.LIVE_EVENTS_TABLE

export const connect = async (event) => {
  const { connectionId, connectedAt } = event.requestContext
  await ddb.send(new PutCommand({
    TableName: CONNECTIONS_TABLE,
    Item: { connectionId, connectedAt, ttl: Math.floor(Date.now() / 1000) + 7200 }
  }))
  return { statusCode: 200 }
}

export const disconnect = async (event) => {
  const { connectionId } = event.requestContext
  await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }))
  return { statusCode: 200 }
}

export const defaultHandler = async (event) => {
  // Send the current live events snapshot to the connecting browser
  const { connectionId, domainName, stage } = event.requestContext
  const endpoint = 'https://' + domainName + '/' + stage
  const mgmt = new ApiGatewayManagementApiClient({ endpoint })

  // Read current live events from DynamoDB
  const now = Math.floor(Date.now() / 1000)
  const result = await ddb.send(new ScanCommand({
    TableName: LIVE_EVENTS_TABLE,
    FilterExpression: '#ttl > :now',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':now': now }
  }))
  const events = (result.Items ?? []).map(({ ttl, lastUpdated, ...rest }) => rest)

  const payload = JSON.stringify({ type: 'snapshot', events, timestamp: new Date().toISOString() })
  try {
    await mgmt.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(payload) }))
  } catch (err) {
    if (err.name !== 'GoneException') console.error('WS send error', err)
  }
  return { statusCode: 200 }
}
