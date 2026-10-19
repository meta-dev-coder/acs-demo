import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import * as path from 'path'
import { Construct } from 'constructs'

export class I595Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── 1. S3 Data Bucket ────────────────────────────────────────────────────
    const dataBucket = new s3.Bucket(this, 'i595CorridorData', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    })

    // Incident camera snapshots are evidence for the demo, not an archive: keep 90 days.
    dataBucket.addLifecycleRule({
      id: 'ExpireIncidentSnapshots',
      prefix: 'snapshots/',
      expiration: cdk.Duration.days(90),
      noncurrentVersionExpiration: cdk.Duration.days(1),
    })
    // DataConnect service client (client_credentials), created once by hand (infra/DEPLOY.md); never in code.
    const DC_SERVICE_CLIENT_SECRET_NAME = 'i595/dataconnect/service-client'
    const dcServiceClientSecret = secretsmanager.Secret.fromSecretNameV2(this, 'DcServiceClientSecret', DC_SERVICE_CLIENT_SECRET_NAME)
    const DC_GATEWAY_URL = 'https://dataconnect-demo-dqa3.cohesivecloud.app'

    // ── 2. DynamoDB: live events ──────────────────────────────────────────────
    const liveEventsTable = new dynamodb.Table(this, 'I595LiveEvents', {
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    })

    // ── 3. DynamoDB: WebSocket connections ───────────────────────────────────
    const wsConnectionsTable = new dynamodb.Table(this, 'I595WsConnections', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    })

    // ── 4. EventBridge custom bus ─────────────────────────────────────────────
    const eventsBus = new events.EventBus(this, 'I595EventsBus', {
      eventBusName: 'i595-events',
    })

    // ── 5. Lambda: poller ─────────────────────────────────────────────────────
    const pollerFn = new NodejsFunction(this, 'PollerFn', {
      entry: path.join(__dirname, '../lambdas/poller/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      // Below the 1-minute schedule so runs never overlap; the DataConnect step stops 5 s before this.
      timeout: cdk.Duration.seconds(55),
      memorySize: 512,
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            const dataDir = path.join(__dirname, '../../public/data');
            return [`cp -r ${dataDir} ${outputDir}/data`];
          },
          beforeBundling(): string[] { return []; },
          beforeInstall(): string[] { return []; },
        },
      },
      environment: {
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
        EVENTS_BUS_ARN: eventsBus.eventBusArn,
        DATA_DIR: '/var/task/data',
        // Live DataConnect writer, signed in with the service client.
        DC_SERVICE_CLIENT_SECRET_NAME,
        LIVE_DC_STATUS_BUCKET: dataBucket.bucketName,
        // Optional: comma list of Live Events keys kept active (cdk deploy -c liveDcHoldOpen=...).
        LIVE_DC_HOLD_OPEN: String(this.node.tryGetContext('liveDcHoldOpen') ?? ''),
        LIVE_DC_DATA_DIR: '/var/task/data',
        DC_WRITER_BASE_URL: DC_GATEWAY_URL,
        DC_WRITER_DATA_MGMT_PREFIX: '/api/data-mgmt/v1',
        DC_WRITER_LOAD_BASE_URL: 'https://dc-load-demo-dqa3.cohesivecloud.app',
        DC_WRITER_TIMEOUT_MS: '10000',
        DC_WRITER_PROCESS_TIMEOUT_MS: '15000',
        DC_WRITER_CURATION_TIMEOUT_MS: '15000',
        LIVE_DC_PROFILE: 'demo',
        LIVE_DC_SPAWN_TYPES: 'INCIDENT,CLOSURE,CONSTRUCTION,CONGESTION,DISABLED',
        LIVE_DC_LINK_MODE: 'live',
        LIVE_DC_HEARTBEAT_SECONDS: '900',
        LIVE_DC_ASSET_REFRESH_SECONDS: '3600',
      },
    })

    liveEventsTable.grantReadWriteData(pollerFn)
    eventsBus.grantPutEventsTo(pollerFn)
    dcServiceClientSecret.grantRead(pollerFn)
    pollerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [dataBucket.arnForObjects('status/*')],
    }))
    // Live Events camera snapshots, public through CloudFront's default behaviour.
    pollerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [dataBucket.arnForObjects('snapshots/*')],
    }))

    // ── 6. EventBridge Scheduler: run poller every 1 minute ──────────────────
    const schedulerRole = new iam.Role(this, 'PollerSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    })
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [pollerFn.functionArn],
      }),
    )

    new scheduler.CfnSchedule(this, 'PollerSchedule', {
      name: 'i595-poller',
      scheduleExpression: 'rate(5 minutes)',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      target: {
        arn: pollerFn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    })

    // ── 7. Lambda: snapshot proxy ─────────────────────────────────────────────
    const snapshotProxyFn = new NodejsFunction(this, 'SnapshotProxyFn', {
      entry: path.join(__dirname, '../lambdas/snapshot-proxy/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        KNOWN_CHAN_IDS: '',
      },
    })

    const snapshotProxyFnUrl = snapshotProxyFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── 8. Lambda: WebSocket handlers ────────────────────────────────────────
    const wsHandlerCommon = {
      entry: path.join(__dirname, '../lambdas/ws-handler/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'] as string[],
      },
    } as const

    const wsConnectFn = new NodejsFunction(this, 'WsConnectFn', {
      ...wsHandlerCommon,
      handler: 'connect',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    const wsDisconnectFn = new NodejsFunction(this, 'WsDisconnectFn', {
      ...wsHandlerCommon,
      handler: 'disconnect',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    const wsDefaultFn = new NodejsFunction(this, 'WsDefaultFn', {
      ...wsHandlerCommon,
      handler: 'defaultHandler',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    wsConnectionsTable.grantReadWriteData(wsConnectFn)
    wsConnectionsTable.grantReadWriteData(wsDisconnectFn)
    wsConnectionsTable.grantReadWriteData(wsDefaultFn)
    liveEventsTable.grantReadData(wsDefaultFn)

    // ── 9. API Gateway WebSocket API (L1 — avoids alpha-package synthesis bugs) ─
    const wsApi = new apigw.CfnApi(this, 'I595WsApi', {
      name: 'i595-websocket-api',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    })

    const makeWsInteg = (id: string, fn: lambda.IFunction) =>
      new apigw.CfnIntegration(this, id, {
        apiId: wsApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: cdk.Stack.of(this).formatArn({
          service: 'apigateway',
          account: 'lambda',
          resource: 'path/2015-03-31/functions',
          resourceName: `${fn.functionArn}/invocations`,
        }),
      })

    const wsConnectInteg    = makeWsInteg('WsConnectInteg',    wsConnectFn)
    const wsDisconnectInteg = makeWsInteg('WsDisconnectInteg', wsDisconnectFn)
    const wsDefaultInteg    = makeWsInteg('WsDefaultInteg',    wsDefaultFn)

    new apigw.CfnRoute(this, 'WsConnectRoute',    { apiId: wsApi.ref, routeKey: '$connect',    target: `integrations/${wsConnectInteg.ref}` })
    new apigw.CfnRoute(this, 'WsDisconnectRoute', { apiId: wsApi.ref, routeKey: '$disconnect', target: `integrations/${wsDisconnectInteg.ref}` })
    new apigw.CfnRoute(this, 'WsDefaultRoute',    { apiId: wsApi.ref, routeKey: '$default',    target: `integrations/${wsDefaultInteg.ref}` })

    new apigw.CfnStage(this, 'I595WsStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
    })

    const wsCallbackUrl = `https://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`
    const wsWssUrl      = `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`

    const wsApiArn = cdk.Stack.of(this).formatArn({ service: 'execute-api', resource: wsApi.ref })
    for (const [fn, key] of [[wsConnectFn, 'connect'], [wsDisconnectFn, 'disconnect'], [wsDefaultFn, 'default']] as [lambda.IFunction, string][]) {
      fn.addPermission(`WsApiGw${key}Permission`, {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: `${wsApiArn}/*/*$${key}`,
      })
    }

    wsDefaultFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`${wsApiArn}/prod/*/@connections/*`],
    }))

    // ── 10. Lambda: broadcaster ───────────────────────────────────────────────
    const broadcasterFn = new NodejsFunction(this, 'BroadcasterFn', {
      entry: path.join(__dirname, '../lambdas/broadcaster/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        WS_API_ENDPOINT: wsCallbackUrl,
      },
    })

    wsConnectionsTable.grantReadWriteData(broadcasterFn)
    broadcasterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`${wsApiArn}/prod/*/@connections/*`],
    }))

    new events.Rule(this, 'EventsChangedRule', {
      eventBus: eventsBus,
      eventPattern: { detailType: ['EventsChanged'] },
      targets: [new eventsTargets.LambdaFunction(broadcasterFn)],
    })

    // ── 11. Lambda: live-events REST ──────────────────────────────────────────
    const liveEventsRestFn = new NodejsFunction(this, 'LiveEventsRestFn', {
      entry: path.join(__dirname, '../lambdas/live-events-rest/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    liveEventsTable.grantReadData(liveEventsRestFn)

    const liveEventsRestFnUrl = liveEventsRestFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── 12. Lambda: Ask the Twin ────────────────────────────────────────────────
    // Opt-in EC2 route for Ask the Twin (section 12b); every flag unset = today's Lambda-only stack.
    const askEc2 = readAskEc2Context(this)
    // Retiring the Lambda drops the function, its URL, its IAM grants and its output.
    let askTheTwinFnUrl: lambda.FunctionUrl | undefined
    if (!askEc2?.retireAskLambda) {
      const askTheTwinFn = new NodejsFunction(this, 'AskTheTwinFn', {
        entry: path.join(__dirname, '../lambdas/ask-the-twin/index.mjs'),
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        bundling: {
          format: OutputFormat.ESM,
          externalModules: ['@aws-sdk/*'],
        },
        environment: {
          LIVE_EVENTS_TABLE: liveEventsTable.tableName,
          ANTHROPIC_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV',
          ANTHROPIC_SECRET_REGION: 'us-east-1',
        },
      })

      liveEventsTable.grantReadData(askTheTwinFn)

      askTheTwinFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV'],
      }))

      askTheTwinFnUrl = askTheTwinFn.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
      })
    }

    // ── 12b. Ask the Twin on the EC2 demo host (opt-in: cdk deploy -c askOrigin=...) ──
    // The GitHub Pages /demo/ site is HTTPS and cannot call the host's plain-HTTP :8095, so CloudFront
    // terminates TLS at the edge and forwards /api/i595/ask* to the host. The host's password gate is a
    // session cookie that Pages visitors never have, so CloudFront proves itself with a shared header
    // (x-ask-edge-key) instead; the value lives in SSM and is resolved at deploy time, never in git.
    // Contract for the host: deploy/ec2/ASK_THE_TWIN.md section 5.1.
    const askBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
    const askLambdaBehavior: cloudfront.BehaviorOptions | undefined = askTheTwinFnUrl && {
      origin: new origins.FunctionUrlOrigin(askTheTwinFnUrl),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    }
    if (askEc2) {
      const askEdgeKey = ssm.StringParameter.valueForStringParameter(this, askEc2.edgeKeyParam)
      const askEc2Origin = new origins.HttpOrigin(askEc2.host, {
        protocolPolicy: askEc2.protocol,
        httpPort: askEc2.protocol === cloudfront.OriginProtocolPolicy.HTTP_ONLY ? askEc2.port : undefined,
        httpsPort: askEc2.protocol === cloudfront.OriginProtocolPolicy.HTTPS_ONLY ? askEc2.port : undefined,
        // 60 s is CloudFront's ceiling without a quota increase. It is the wait for the first byte and
        // then between bytes, so a streamed answer can run longer as long as events (or SSE comment
        // pings) keep arriving; a buffered JSON answer must finish inside it.
        readTimeout: cdk.Duration.seconds(60),
        // CloudFront must drop an idle connection before the origin does, or it reuses a socket the host
        // already closed and the viewer gets a 502. Node's http server closes idle sockets after 5 s by
        // default, hence 4 s; raise askOriginKeepaliveSeconds (max 60) once the host sets
        // server.keepAliveTimeout above it.
        keepaliveTimeout: cdk.Duration.seconds(askEc2.keepaliveSeconds),
        // A stopped host should fail fast (2 x 5 s) rather than hold the chat for 30 s.
        connectionTimeout: cdk.Duration.seconds(5),
        connectionAttempts: 2,
        customHeaders: { 'x-ask-edge-key': askEdgeKey },
      })
      const askOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AskEc2OriginRequestPolicy', {
        comment: 'Ask the Twin to the EC2 demo host: body headers, the viewer address for rate limits, no cookies',
        // Accept selects SSE vs JSON; CloudFront-Viewer-Address carries the viewer IP:port for the host's
        // per-IP rate limit (it only sees CloudFront's addresses otherwise). No cookies: the Pages page
        // sends none, and the host's session cookie must not be usable through this path.
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          'Accept', 'Content-Type', 'Origin', 'CloudFront-Viewer-Address',
        ),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      })
      // The Lambda answered CORS itself with '*'; here CloudFront adds it (originOverride) so the host
      // only has to return 2xx to the OPTIONS preflight. Limited to the Pages origin(s).
      const askCorsPolicy = new cloudfront.ResponseHeadersPolicy(this, 'AskEc2CorsPolicy', {
        comment: 'Ask the Twin (EC2 origin): CORS for the GitHub Pages demo',
        corsBehavior: {
          accessControlAllowOrigins: askEc2.corsOrigins,
          accessControlAllowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
          accessControlAllowHeaders: ['content-type', 'accept'],
          accessControlAllowCredentials: false,
          accessControlMaxAge: cdk.Duration.seconds(600),
          originOverride: true,
        },
      })
      if (askLambdaBehavior) {
        // Kept for rollback without a redeploy (point VITE_ASK_THE_TWIN_API here). It must come before
        // '/api/i595/ask*', which also matches it: CloudFront takes the first matching behaviour in order.
        // The Lambda ignores the request path, so the different path needs no Lambda change.
        askBehaviors['/api/i595/ask-lambda*'] = askLambdaBehavior
      }
      // Same pattern as the Lambda had, so the Pages build's URL (and /api/i595/ask/status) keep working.
      askBehaviors['/api/i595/ask*'] = {
        origin: askEc2Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: askOriginRequestPolicy,
        responseHeadersPolicy: askCorsPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // CloudFront would gzip a text response and buffer the stream while doing it; SSE must flow as
        // the host writes it. Chunked origin responses are passed through as they arrive.
        compress: false,
      }
      new cdk.CfnOutput(this, 'AskEc2Origin', {
        value: `${askEc2.host}:${askEc2.port} (${askEc2.protocol})`,
      })
    } else if (askLambdaBehavior) {
      askBehaviors['/api/i595/ask*'] = askLambdaBehavior
    }

    // ── 13. CloudFront Distribution ───────────────────────────────────────────
    const oac = new cloudfront.CfnOriginAccessControl(this, 'DataBucketOAC', {
      originAccessControlConfig: {
        name: 'i595-data-bucket-oac',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    })

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(dataBucket)

    const staticDataCachePolicy = new cloudfront.CachePolicy(this, 'StaticDataCachePolicy', {
      defaultTtl: cdk.Duration.seconds(86400),
      maxTtl: cdk.Duration.seconds(86400),
      minTtl: cdk.Duration.seconds(0),
    })

    const snapshotCachePolicy = new cloudfront.CachePolicy(this, 'SnapshotCachePolicy', {
      defaultTtl: cdk.Duration.seconds(60),
      maxTtl: cdk.Duration.seconds(90),
      minTtl: cdk.Duration.seconds(0),
    })

    const distribution = new cloudfront.Distribution(this, 'I595Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/data/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: staticDataCachePolicy,
        },
        '/api/i595/camera/*': {
          origin: new origins.FunctionUrlOrigin(snapshotProxyFnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        '/api/i595/live-events*': {
          origin: new origins.FunctionUrlOrigin(liveEventsRestFnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        ...askBehaviors,
        // Non-secret poller status (status/live-dc-status.json), read cross-origin by the page.
        '/status/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        },
      },
    })

    // Snapshot links stored in DataConnect: images under snapshots/ and the live camera proxy, both on this distribution.
    const publicBase = `https://${distribution.distributionDomainName}`
    pollerFn.addEnvironment('LIVE_DC_SNAPSHOT_BUCKET', dataBucket.bucketName)
    pollerFn.addEnvironment('LIVE_DC_SNAPSHOT_PUBLIC_BASE', publicBase)
    pollerFn.addEnvironment('LIVE_DC_PUBLIC_API_BASE', publicBase)

    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      oac.attrId,
    )
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity',
      '',
    )

    dataBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [dataBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    )

    // ── 14. CfnOutputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    })

    new cdk.CfnOutput(this, 'WsEndpoint', {
      value: wsWssUrl,
    })

    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
    })

    new cdk.CfnOutput(this, 'SnapshotFunctionUrl', {
      value: snapshotProxyFnUrl.url,
    })

    new cdk.CfnOutput(this, 'LiveEventsFunctionUrl', {
      value: liveEventsRestFnUrl.url,
    })

    if (askTheTwinFnUrl) {
      new cdk.CfnOutput(this, 'AskTheTwinFunctionUrl', {
        value: askTheTwinFnUrl.url,
      })
    }

    new cdk.CfnOutput(this, 'LiveDcStatusUrl', {
      value: `https://${distribution.distributionDomainName}/status/live-dc-status.json`,
    })
  }
}

export interface AskEc2Context {
  host: string
  port: number
  protocol: cloudfront.OriginProtocolPolicy
  keepaliveSeconds: number
  edgeKeyParam: string
  corsOrigins: string[]
  retireAskLambda: boolean
}

// The GitHub Pages site that calls Ask the Twin (owner of meta-dev-coder/acs-demo).
const DEFAULT_ASK_CORS_ORIGINS = ['https://meta-dev-coder.github.io']

/**
 * Reads the Ask the Twin EC2 flags from CDK context (-c key=value, so every value may arrive as a string).
 * Returns undefined when askOrigin is unset: the stack is then exactly the Lambda-only one. Throws on a
 * combination that would deploy something unsafe or broken rather than guessing.
 */
export function readAskEc2Context(scope: Construct): AskEc2Context | undefined {
  const raw = (key: string): string => String(scope.node.tryGetContext(key) ?? '').trim()
  const flag = (key: string): boolean => {
    const v = raw(key).toLowerCase()
    if (v === '' || v === 'false' || v === '0') return false
    if (v === 'true' || v === '1') return true
    throw new Error(`context ${key} must be true or false, got "${raw(key)}"`)
  }
  const host = raw('askOrigin')
  const retireAskLambda = flag('retireAskLambda')
  if (!host) {
    // Retiring the Lambda with nothing in its place would leave /api/i595/ask* on the S3 default behaviour.
    if (retireAskLambda) throw new Error('retireAskLambda=true needs askOrigin: there would be no Ask the Twin route')
    return undefined
  }
  // CloudFront custom origins take a DNS name only: no scheme, port, path or bare IP address.
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) {
    throw new Error(`askOrigin must be a DNS name like ec2-34-237-187-140.compute-1.amazonaws.com, got "${host}"`)
  }
  const port = Number(raw('askOriginPort') || 8095)
  if (!Number.isInteger(port) || !(port === 80 || port === 443 || (port >= 1024 && port <= 65535))) {
    throw new Error(`askOriginPort must be 80, 443 or 1024-65535 (CloudFront's allowed origin ports), got "${raw('askOriginPort')}"`)
  }
  const protocolName = raw('askOriginProtocol') || 'http-only'
  const protocols: Record<string, cloudfront.OriginProtocolPolicy> = {
    'http-only': cloudfront.OriginProtocolPolicy.HTTP_ONLY, // the host serves plain HTTP today
    'https-only': cloudfront.OriginProtocolPolicy.HTTPS_ONLY, // only once the host has a valid certificate
  }
  const protocol = protocols[protocolName]
  if (!protocol) throw new Error(`askOriginProtocol must be http-only or https-only, got "${protocolName}"`)
  const keepaliveSeconds = Number(raw('askOriginKeepaliveSeconds') || 4)
  if (!Number.isInteger(keepaliveSeconds) || keepaliveSeconds < 1 || keepaliveSeconds > 60) {
    throw new Error(`askOriginKeepaliveSeconds must be 1-60, got "${raw('askOriginKeepaliveSeconds')}"`)
  }
  // Without the edge key the host could not tell CloudFront from anyone else, so this would be an open,
  // unauthenticated proxy to a paid model. Refuse rather than deploy that.
  const edgeKeyParam = raw('askEdgeKeyParam')
  if (!edgeKeyParam) throw new Error('askOrigin needs askEdgeKeyParam: the SSM String parameter name holding the x-ask-edge-key value')
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(edgeKeyParam)) {
    throw new Error(`askEdgeKeyParam must be an SSM parameter name (not the key itself), got an invalid name`)
  }
  const corsOrigins = raw('askCorsOrigins') ? raw('askCorsOrigins').split(',').map(o => o.trim()).filter(Boolean) : DEFAULT_ASK_CORS_ORIGINS
  return { host, port, protocol, keepaliveSeconds, edgeKeyParam, corsOrigins, retireAskLambda }
}
